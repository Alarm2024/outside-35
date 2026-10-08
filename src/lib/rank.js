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
export async function rank(score, { question, neutral, answer }, candidates, baselines = new Map()) {
  const out = [];
  for (const c of candidates) {
    const a = answer(c);
    // The no-plan score never changes, so it is worked out once per answer.
    const key = `${neutral}\n${a.prefix}${a.text}`;
    if (!baselines.has(key)) baselines.set(key, await score(neutral, a));
    out.push({ c, score: (await score(question, a)) - baselines.get(key) });
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * The model as rankShared needs it: token ids in, logits for the last `keep`
 * positions out, optionally continuing from a cache of earlier positions
 * (Transformers.js past_key_values). The same in the browser worker and in Node.
 * @param {typeof import('@huggingface/transformers').Tensor} Tensor
 */
export function makeLM(tokenizer, model, Tensor) {
  const int64 = (values, dims) => new Tensor('int64', BigInt64Array.from(values, BigInt), dims);
  return {
    encode: (text) => Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data, Number),
    prompt: (question) => tokenizer.apply_chat_template([{ role: 'user', content: question }], { tokenize: false, add_generation_prompt: true }),
    async run(ids, cache, keep) {
      const length = (cache ? cache.length : 0) + ids.length;
      const out = await model({
        input_ids: int64(ids, [1, ids.length]),
        attention_mask: int64(new Array(length).fill(1), [1, length]),
        ...(cache ? { past_key_values: cache.tensors } : {}),
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

/**
 * Mean log-probability of each answer to one question. The prompt is the
 * same for every answer, so the model reads it once and keeps its cache;
 * each answer then costs only its own few tokens, with logits only where
 * they are read. Same scores as makeScorer, a fraction of the work.
 * @param {(n: number) => void} onScored called after each answer
 */
export async function scoreShared(lm, question, answers, onScored = () => {}) {
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
  const head = shared >= 1 ? await lm.run(items[0].ids.slice(0, shared), null, 1) : null;
  try {
    const scores = [];
    for (const x of items) {
      const start = head ? shared : 0;
      // Rows from the one before the answer's first token to the end.
      const keep = Math.min(x.ids.length - x.from + 1, x.ids.length - start);
      const run = await lm.run(x.ids.slice(start), head && head.cache, keep);
      try {
        const [, rows, vocab] = run.logits.dims;
        scores.push(meanLogProbAt(run.logits.data, vocab, x.ids, x.from, x.ids.length - rows));
      } finally {
        run.dispose();
      }
      onScored(scores.length);
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
