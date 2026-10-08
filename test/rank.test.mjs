import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonPrefixLength, describePlan, meanLogProb, meanLogProbAt, rank, rankingQuestions, rankShared, rankSteps, scoreShared } from '../src/lib/rank.js';
import { conditionWords } from '../src/lib/plan.js';

test('mean log-probability reads the row before each token', () => {
  // Vocabulary of 2. Row 0 predicts token 1, row 1 predicts token 2.
  const logits = Float32Array.from([0, 0, Math.log(3), 0]);
  // Token 1 is id 0 (row 0: p = 1/2); token 2 is id 0 (row 1: p = 3/4).
  const lp = meanLogProb(logits, 2, [1, 0, 0], 1);
  assert.ok(Math.abs(lp - (Math.log(1 / 2) + Math.log(3 / 4)) / 2) < 1e-6, String(lp));
  assert.equal(meanLogProb(logits, 2, [1], 1), -Infinity, 'nothing to score');
  assert.equal(commonPrefixLength([1, 2, 3], [1, 2, 4, 5]), 2);
});

test('ranking is by how much the plan lifts each answer, and baselines are reused', async () => {
  const calls = [];
  const fake = async (question, { text }) => {
    calls.push(question);
    const plan = question.includes('hike');
    // "water" is likely everywhere; "a torch" only for this plan.
    if (text === 'water.') return plan ? -1 : -1.1;
    return plan ? -2 : -4;
  };
  const q = rankingQuestions({ activity: 'hike', words: null, seasonName: 'winter', part: 'morning' }).bring;
  const baselines = new Map();
  const out = await rank(fake, q, ['water', 'a torch'], baselines);
  assert.deepEqual(out.map((x) => x.c), ['a torch', 'water']);
  assert.equal(baselines.size, 2);
  const before = calls.length;
  await rank(fake, q, ['water', 'a torch'], baselines);
  assert.equal(calls.length - before, 2, 'second plan scores only the plan, not the baselines again');
});

test('the questions carry words, never numbers', () => {
  const words = conditionWords({ minTemp: 3, maxTemp: 9, maxPop: 70, maxUv: 1, maxWind: 25, thunder: false });
  const q = rankingQuestions({ activity: 'hike', words, seasonName: 'autumn', part: 'morning' });
  assert.equal(describePlan({ activity: 'hike', words, seasonName: 'autumn', part: 'morning' }), 'a hike on a cold, rain likely day in the morning in autumn');
  assert.equal(describePlan({ activity: 'walk', words: null, seasonName: 'unknown', part: 'unknown' }), 'a short walk');
  for (const s of [q.bring.question, q.notice.question, q.bring.neutral]) assert.doesNotMatch(s, /[0-9]/);
});

// A stand-in for the model: each logits row depends only on the tokens up to
// its position, as in a causal model, so a run that continues from a cache
// must give exactly the rows a full run gives. Words are tokens, and a space
// or newline joins the word after it, so the space after "Bring" merges into
// the answer's first token, as it does in Gemma's tokenizer.
function fakeLM({ keepSupported = true } = {}) {
  const V = 97;
  const vocab = new Map();
  const id = (t) => {
    if (!vocab.has(t)) vocab.set(t, vocab.size);
    return vocab.get(t) % V;
  };
  const row = (prefix) => {
    let h = 7;
    for (const x of prefix) h = (h * 31 + x + 1) % 1000003;
    return Array.from({ length: V }, (_, j) => Math.sin(h * (j + 1)) * 3);
  };
  const stats = { runs: 0, tokens: 0, rows: 0, open: 0 };
  const lm = {
    stats,
    encode: (text) => (text.match(/\s?\S+|\s+$/g) || []).map(id),
    // Shaped like Gemma's chat template.
    prompt: (question) => `<bos><start_of_turn> user ${question} <end_of_turn> <start_of_turn> model\n`,
    async run(ids, cache, keep) {
      const all = [...(cache ? cache.ids : []), ...ids];
      const first = all.length - (keepSupported ? keep : ids.length);
      const data = [];
      for (let p = first; p < all.length; p += 1) data.push(...row(all.slice(0, p + 1)));
      stats.runs += 1;
      stats.tokens += ids.length;
      stats.rows += all.length - first;
      stats.open += 1;
      return {
        logits: { data: Float32Array.from(data), dims: [1, all.length - first, V] },
        cache: { length: all.length, ids: all },
        dispose: () => { stats.open -= 1; },
      };
    },
    prefix: (cache, n) => ({ length: n, ids: cache.ids.slice(0, n) }),
    // The old way: the whole sequence, every row.
    async full(question, { prefix, text }) {
      const head = lm.encode(lm.prompt(question) + prefix);
      const all = lm.encode(lm.prompt(question) + prefix + text);
      const r = await lm.run(all, null, all.length);
      r.dispose();
      return meanLogProb(r.logits.data, V, all, commonPrefixLength(head, all));
    },
  };
  return lm;
}

const ANSWERS = [
  { prefix: 'Bring ', text: 'a snack.' },
  { prefix: 'Bring ', text: 'water.' },
  { prefix: 'Bring ', text: 'a first aid kit.' },
];
const NOTICES = [
  { prefix: '', text: 'Look for the first leaves changing colour.' },
  { prefix: '', text: 'Count the different bird calls you can hear.' },
];

test('logits that start later in the sequence are read from the right rows', () => {
  // Rows for positions 1 and 2 only. Position 1 predicts token 2 (id 0, p = 1/2).
  const logits = Float32Array.from([0, 0, Math.log(3), 0]);
  assert.ok(Math.abs(meanLogProbAt(logits, 2, [1, 1, 0, 0], 2, 1) - (Math.log(1 / 2) + Math.log(3 / 4)) / 2) < 1e-6);
  assert.throws(() => meanLogProbAt(logits, 2, [1, 1, 0, 0], 1, 1), /start after/);
});

for (const keepSupported of [true, false]) {
  test(`one shared prompt run gives the same scores as one full run per answer (num_logits_to_keep ${keepSupported ? 'used' : 'not in the model'})`, async () => {
    const plan = 'I am going out for a hike on a cold, rain likely day in the morning in winter.';
    for (const [question, answers] of [[`${plan} What is the most useful thing to bring?`, ANSWERS], [`${plan} What is one small thing I could notice outside?`, NOTICES]]) {
      const lm = fakeLM({ keepSupported });
      const expected = [];
      for (const a of answers) expected.push(await lm.full(question, a));
      const full = { ...lm.stats };
      lm.stats.runs = 0; lm.stats.tokens = 0; lm.stats.rows = 0;
      const got = await scoreShared(lm, question, answers);
      assert.deepEqual(got, expected);
      assert.ok(got.every(Number.isFinite));
      assert.equal(lm.stats.runs, answers.length, 'one run per answer: the prompt is read in the first one');
      // The prompt once (inside the first, shortest answer), then each answer's own tokens (plus one where a space merged).
      const promptTokens = lm.encode(lm.prompt(question)).length;
      const own = answers.map((a) => lm.encode(lm.prompt(question) + a.prefix + a.text).length - promptTokens + 1);
      assert.ok(lm.stats.tokens <= promptTokens + own.reduce((x, y) => x + y, 0), `${lm.stats.tokens} tokens vs ${full.tokens}`);
      assert.ok(lm.stats.tokens < full.tokens, `${lm.stats.tokens} tokens vs ${full.tokens}`);
      if (keepSupported) assert.ok(lm.stats.rows < full.rows / 3, `${lm.stats.rows} logits rows vs ${full.rows}`);
      assert.equal(lm.stats.open, 0, 'every cache is released (GPU memory on WebGPU)');
    }
  });
}

test('the answer\'s first token is scored even when the space before it merges into it', async () => {
  const lm = fakeLM();
  const head = lm.encode(`${lm.prompt('Q?')}Bring `);
  const all = lm.encode(`${lm.prompt('Q?')}Bring a snack.`);
  // "Bring " ends in a space token that "a snack." swallows: the answer starts one token earlier.
  assert.equal(commonPrefixLength(head, all), head.length - 1);
  assert.deepEqual(await scoreShared(lm, 'Q?', [ANSWERS[0]]), [await lm.full('Q?', ANSWERS[0])]);
  assert.deepEqual(await scoreShared(lm, 'Q?', []), []);
});

test('rankShared ranks like rank, reuses the no-plan scores, and reports every step', async () => {
  const lm = fakeLM();
  const q = rankingQuestions({ activity: 'hike', words: null, seasonName: 'winter', part: 'morning' }).bring;
  const items = ['water', 'a torch', 'a map'];
  const reference = await rank((question, a) => lm.full(question, a), q, items, new Map());
  const baselines = new Map();
  assert.equal(rankSteps(q, items, baselines), 6, 'three no-plan scores, then three for the plan');
  const steps = [];
  const got = await rankShared(lm, q, items, baselines, (n) => steps.push(n));
  assert.deepEqual(got, reference);
  assert.equal(steps.length, 6);
  assert.equal(baselines.size, 3);
  assert.equal(rankSteps(q, items, baselines), 3, 'the next plan scores only the plan');
  const again = [];
  await rankShared(lm, q, items, baselines, (n) => again.push(n));
  assert.equal(again.length, 3);
});
