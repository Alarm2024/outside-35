// Scratch: can Gemma 3 270M rank human-written options sensibly by likelihood?
import { AutoTokenizer, AutoModelForCausalLM, env } from '@huggingface/transformers';
import { appendFile } from 'node:fs/promises';
import { MODEL } from '../src/lib/model-info.js';
import { bringOptions, conditionWords } from '../src/lib/plan.js';

env.cacheDir = './.hf-cache/';
const t0 = Date.now();
const tok = await AutoTokenizer.from_pretrained(MODEL.id);
const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype: MODEL.dtype });
const lines = [`## Score lab (load ${((Date.now() - t0) / 1000).toFixed(1)} s)`, ''];

const ids = (text) => Array.from(tok(text, { add_special_tokens: false }).input_ids.data, Number);
let forwards = 0; let fwdMs = 0;
async function logprob(prefix, cand) {
  const p = ids(prefix);
  const full = tok(prefix + cand, { add_special_tokens: false });
  const f = Array.from(full.input_ids.data, Number);
  let n0 = 0;
  while (n0 < p.length && n0 < f.length && p[n0] === f[n0]) n0 += 1;
  const t = Date.now();
  const { logits } = await model(full);
  fwdMs += Date.now() - t; forwards += 1;
  const V = logits.dims[2];
  const data = logits.data;
  let sum = 0;
  for (let i = Math.max(n0, 1); i < f.length; i += 1) {
    const row = data.subarray((i - 1) * V, i * V);
    let max = -Infinity; for (let j = 0; j < V; j += 1) if (row[j] > max) max = row[j];
    let s = 0; for (let j = 0; j < V; j += 1) s += Math.exp(row[j] - max);
    sum += row[f[i]] - max - Math.log(s);
  }
  return sum / Math.max(1, f.length - Math.max(n0, 1));
}
const chat = (q, a) => tok.apply_chat_template([{ role: 'user', content: q }], { tokenize: false, add_generation_prompt: true }) + a;
const ACT = { walk: 'a short walk', hike: 'a hike', garden: 'an hour in the garden' };
const F = (minTemp, maxTemp, maxPop, maxUv, maxWind, thunder = false) => ({ minTemp, maxTemp, maxPop, maxUv, maxWind, thunder });
const scenarios = [
  ['walk', F(14, 17, 10, 2, 12), 'autumn', 'afternoon'],
  ['hike', F(3, 8, 70, 1, 35), 'winter', 'morning'],
  ['garden', F(22, 29, 0, 8, 8), 'summer', 'midday'],
  ['hike', null, 'spring', 'morning'],
  ['walk', F(-3, 2, 10, 1, 15), 'winter', 'afternoon'],
  ['walk', F(26, 33, 5, 9, 10), 'summer', 'evening'],
];
const NOTICES = [
  'Listen for the quietest sound around you.',
  'Count the different bird calls you can hear.',
  'Find one tree and notice the shape of its leaves.',
  'Look for the first leaves changing colour.',
  'Look for new buds on the branches.',
  'Look at the bare branches against the sky.',
  'Watch the bees and insects around the flowers.',
  'Notice your breath in the cold air.',
  'Watch how the rain darkens the ground and the bark.',
  'Find a patch of shade and feel how much cooler it is.',
  'Watch the light change as the sun gets lower.',
  'Listen for birds starting their morning songs.',
  'Touch the soil and notice whether it is dry or damp.',
];
const desc = (a, w, s, p) => `${ACT[a]}${w ? ` on a ${w.temp}, ${w.rain} day` : ''}${p !== 'unknown' ? ` in the ${p}` : ''}${s !== 'unknown' ? ` in ${s}` : ''}`;
for (const [a, f, s, p] of scenarios) {
  const w = conditionWords(f);
  const o = bringOptions(a, w);
  const qB = `I am going out for ${desc(a, w, s, p)}. What is the most useful thing to bring?`;
  const qN = `I am going out for ${desc(a, w, s, p)}. What is one small thing I could notice outside?`;
  const nB = `I am going out. What is the most useful thing to bring?`;
  const nN = `I am going out. What is one small thing I could notice outside?`;
  const bring = [];
  for (const c of o.optional) {
    const ctx = await logprob(chat(qB, 'Bring '), `${c}.`);
    const base = await logprob(chat(nB, 'Bring '), `${c}.`);
    bring.push({ c, ctx, pmi: ctx - base });
  }
  const notice = [];
  for (const c of NOTICES) {
    const ctx = await logprob(chat(qN, ''), c);
    const base = await logprob(chat(nN, ''), c);
    notice.push({ c, ctx, pmi: ctx - base });
  }
  const top = (arr, k, key) => [...arr].sort((x, y) => y[key] - x[key]).slice(0, k).map((x) => `${x.c} (${x[key].toFixed(2)})`).join('; ');
  lines.push(`### ${desc(a, w, s, p)}`,
    `- bring by ctx: ${top(bring, 3, 'ctx')}`, `- bring by pmi: ${top(bring, 3, 'pmi')}`,
    `- notice by ctx: ${top(notice, 3, 'ctx')}`, `- notice by pmi: ${top(notice, 3, 'pmi')}`, '');
}
lines.push(`${forwards} forward passes, mean ${(fwdMs / forwards).toFixed(0)} ms each on the CI CPU (native, multi-thread).`, '');
const md = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
