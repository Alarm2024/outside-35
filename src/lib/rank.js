// Gemma ranks; it does not write. Every candidate (a thing to bring, a thing
// to notice) was written by people and allowed by the data. The model scores
// how likely it finds each one as the answer to a question about this plan,
// and the highest scores win. So the model can choose, but it cannot invent
// a fact or an item, and every answer is a whole, sensible sentence.

const ACTIVITY_WORDS = { walk: 'a short walk', hike: 'a hike', garden: 'an hour in the garden' };

/** "a hike on a cold, rain likely day in the morning in winter": words only, never numbers. */
export function describePlan({ activity, words, seasonName, part }) {
  let d = ACTIVITY_WORDS[activity];
  if (words) d += ` on a ${words.temp}, ${words.rain} day`;
  if (part && part !== 'unknown') d += ` in the ${part}`;
  if (seasonName && seasonName !== 'unknown' && !seasonName.startsWith('tropical')) d += ` in ${seasonName}`;
  return d;
}

/** The two questions the model answers by ranking, for this plan and with no plan at all. */
export function rankingQuestions(plan) {
  const d = describePlan(plan);
  return {
    bring: {
      question: `I am going out for ${d}. What is the most useful thing to bring?`,
      neutral: 'I am going out. What is the most useful thing to bring?',
      answer: (c) => ({ prefix: 'Bring ', text: `${c}.` }),
    },
    notice: {
      question: `I am going out for ${d}. What is one small thing I could notice outside?`,
      neutral: 'I am going out. What is one small thing I could notice outside?',
      answer: (c) => ({ prefix: '', text: c }),
    },
  };
}

/**
 * Mean log-probability of ids[from..], where logits row i-1 predicts token i.
 * @param {Float32Array} logits flat [length, vocab]
 */
export function meanLogProb(logits, vocab, ids, from) {
  return meanLogProbAt(logits, vocab, ids, from, 0);
}

/**
 * The same, when the logits start at sequence position `first` (a run that
 * reused a cache, or kept only its last rows): row r is position first + r.
 */
export function meanLogProbAt(logits, vocab, ids, from, first) {
  const start = Math.max(from, 1);
  if (start >= ids.length) return -Infinity;
  if (start - 1 < first) throw new Error('the logits start after the first token to score');
  let sum = 0;
  for (let i = start; i < ids.length; i += 1) {
    const row = logits.subarray((i - 1 - first) * vocab, (i - first) * vocab);
    let max = -Infinity;
    for (let j = 0; j < vocab; j += 1) if (row[j] > max) max = row[j];
    let total = 0;
    for (let j = 0; j < vocab; j += 1) total += Math.exp(row[j] - max);
    sum += row[ids[i]] - max - Math.log(total);
  }
  return sum / (ids.length - start);
}

export function commonPrefixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Scores one answer to one question with a Transformers.js tokenizer and
 * causal language model (the same in the browser worker and in Node): one
 * full run of the model per answer. The app uses rankShared below, which gives
 * the same scores for a fraction of the work; this one stays as the reference
 * the model check and the browser bench measure it against.
 */
export function makeScorer(tokenizer, model) {
  const ids = (text) => Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number);
  const prompt = (question) => tokenizer.apply_chat_template([{ role: 'user', content: question }], { tokenize: false, add_generation_prompt: true });
  return async (question, { prefix, text }) => {
    const head = prompt(question) + prefix;
    const inputs = tokenizer(head + text, { add_special_tokens: false });
    const all = Array.from(inputs.input_ids.data, Number);
    const { logits } = await model(inputs);
    return meanLogProb(logits.data, logits.dims[2], all, commonPrefixLength(ids(head), all));
  };
}

/**
 * Ranks candidates for one question, best first. The score is how much more
 * likely the model finds an answer for this plan than for no plan at all, so
 * an answer that is likely everywhere does not win every time. (Measured: by
 * plain likelihood one Notice line won five of six test plans; this way the
 * choice follows the plan.)
 */
export async function rank(score, { question, neutral, answer }, candidates, baselines = new Map(), onScored = () => {}) {
  const out = [];
  for (const c of candidates) {
    const a = answer(c);
    // The no-plan score never changes, so it is worked out once per answer.
    const key = `${neutral}\n${a.prefix}${a.text}`;
    if (!baselines.has(key)) {
      baselines.set(key, await score(neutral, a));
      onScored();
    }
    out.push({ c, score: (await score(question, a)) - baselines.get(key) });
    onScored();
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * The model as rankShared needs it: rows of token ids in (all the same
 * length), logits for the last `keep` positions of each row out, optionally
 * continuing from a cache of earlier positions (Transformers.js
 * past_key_values). The same in the browser worker and in Node.
 * @param {typeof import('@huggingface/transformers').Tensor} Tensor
 */
export function makeLM(tokenizer, model, Tensor) {
  const int64 = (values, dims) => new Tensor('int64', BigInt64Array.from(values, BigInt), dims);
  // A cache read once for one row, copied for every row of a batch.
  const tile = (t, batch) => {
    if (t.dims[0] === batch) return t;
    if (t.location === 'gpu-buffer') throw new Error('a batched run needs its cache on the CPU');
    const data = new t.data.constructor(t.data.length * batch);
    for (let b = 0; b < batch; b += 1) data.set(t.data, b * t.data.length);
    return new Tensor(t.type, data, [batch, ...t.dims.slice(1)]);
  };
  return {
    encode: (text) => Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number),
    prompt: (question) => tokenizer.apply_chat_template([{ role: 'user', content: question }], { tokenize: false, add_generation_prompt: true }),
    async run(rows, cache, keep) {
      const batch = rows.length;
      const width = rows[0].length;
      const length = (cache ? cache.length : 0) + width;
      const past = {};
      if (cache) for (const [name, t] of Object.entries(cache.tensors)) past[name] = tile(t, batch);
      const out = await model({
        input_ids: int64(rows.flat(), [batch, width]),
        // All ones, even under padding: see scoreShared.
        attention_mask: int64(new Array(batch * length).fill(1), [batch, length]),
        ...(cache ? { past_key_values: past } : {}),
        // Only models exported with this input use it; others return every row.
        num_logits_to_keep: int64([keep], []),
      });
      const tensors = {};
      for (const name of Object.keys(out)) {
        if (name.startsWith('present')) tensors[name.replace('present', 'past_key_values')] = out[name];
      }
      return {
        logits: out.logits,
        cache: { length, tensors },
        // On WebGPU the cache lives in GPU buffers, which are freed only by hand.
        dispose: () => { for (const t of Object.values(tensors)) t.dispose(); },
      };
    },
  };
}

// Each logits row is the whole vocabulary (262,144 floats, 1 MB), so a run
// holds at most this many rows: about 64 MB, fine on a phone.
const MAX_ROWS = 64;

/**
 * Mean log-probability of each answer to one question. The prompt is the
 * same for every answer, so the model reads it once and keeps its cache; the
 * answers then run together, a few per model call. Same scores as makeScorer
 * (one full run per answer) for a fraction of the work: in the browser's CPU
 * build each call costs about a second whatever its length, so fewer calls is
 * what counts.
 *
 * Answers of different lengths are padded at the end, and the attention mask
 * stays all ones. This model works out positions and cache offsets from the
 * mask (GroupQueryAttention), so masking the padding would shift them; and
 * padding at the end needs no mask, because the model is causal: no real token
 * ever sees a token after it.
 * @param {(n: number) => void} onScored called after each answer
 */
export async function scoreShared(lm, question, answers, onScored = () => {}, { maxRows = MAX_ROWS } = {}) {
  if (!answers.length) return [];
  const prompt = lm.prompt(question);
  const heads = new Map();
  const items = answers.map((a) => {
    const head = prompt + a.prefix;
    if (!heads.has(head)) heads.set(head, lm.encode(head));
    const ids = lm.encode(head + a.text);
    // The answer starts where its tokens leave the question's (a space before
    // the answer can merge into its first token).
    return { ids, from: commonPrefixLength(heads.get(head), ids) };
  });
  // The shared tokens end before the first token any answer is scored on, so
  // each answer's own run includes the row that predicts its first token.
  let shared = Math.min(...items.map((x) => x.from)) - 1;
  for (const x of items) shared = Math.min(shared, commonPrefixLength(items[0].ids, x.ids));
  const head = shared >= 1 ? await lm.run([items[0].ids.slice(0, shared)], null, 1) : null;
  const start = head ? shared : 0;
  // Shortest first, so answers of similar length share a run and pad little.
  const order = items.map((_, i) => i).sort((a, b) => items[a].ids.length - items[b].ids.length);
  const chunks = [];
  for (const i of order) {
    const chunk = chunks.at(-1);
    const width = items[i].ids.length - start;
    if (chunk && (chunk.length + 1) * width <= maxRows) chunk.push(i);
    else chunks.push([i]);
  }
  try {
    const scores = new Array(items.length);
    let done = 0;
    for (const chunk of chunks) {
      const width = Math.max(...chunk.map((i) => items[i].ids.length)) - start;
      const rows = chunk.map((i) => {
        const own = items[i].ids.slice(start);
        return own.concat(new Array(width - own.length).fill(0));
      });
      const run = await lm.run(rows, head && head.cache, width);
      try {
        const [, kept, vocab] = run.logits.dims;
        chunk.forEach((i, b) => {
          const x = items[i];
          const logits = run.logits.data.subarray(b * kept * vocab, (b + 1) * kept * vocab);
          scores[i] = meanLogProbAt(logits, vocab, x.ids, x.from, start + width - kept);
        });
      } finally {
        run.dispose();
      }
      for (let k = 0; k < chunk.length; k += 1) onScored((done += 1));
    }
    return scores;
  } finally {
    if (head) head.dispose();
  }
}

/** How many answers rankShared will score for one question (the progress total). */
export function rankSteps({ neutral, answer }, candidates, baselines) {
  const missing = candidates.filter((c) => {
    const a = answer(c);
    return !baselines.has(`${neutral}\n${a.prefix}${a.text}`);
  });
  return candidates.length + missing.length;
}

/** rank, with scoreShared: the no-plan scores first (once per answer), then this plan's. */
export async function rankShared(lm, { question, neutral, answer }, candidates, baselines = new Map(), onScored = () => {}) {
  const answers = candidates.map(answer);
  const keys = answers.map((a) => `${neutral}\n${a.prefix}${a.text}`);
  const missing = answers.filter((_, i) => !baselines.has(keys[i]));
  if (missing.length) {
    const s = await scoreShared(lm, neutral, missing, onScored);
    missing.forEach((a, i) => baselines.set(`${neutral}\n${a.prefix}${a.text}`, s[i]));
  }
  const scores = await scoreShared(lm, question, answers, onScored);
  return candidates.map((c, i) => ({ c, score: scores[i] - baselines.get(keys[i]) })).sort((x, y) => y.score - x.score);
}
