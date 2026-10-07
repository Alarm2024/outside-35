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
  const start = Math.max(from, 1);
  if (start >= ids.length) return -Infinity;
  let sum = 0;
  for (let i = start; i < ids.length; i += 1) {
    const row = logits.subarray((i - 1) * vocab, i * vocab);
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
 * causal language model (the same in the browser worker and in Node).
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
