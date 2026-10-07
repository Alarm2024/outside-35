// Scratch experiment (not for main): which prompt shape gets usable answers
// from Gemma 3 270M IT, scored by the app's own check.
import { pipeline, env } from '@huggingface/transformers';
import { appendFile } from 'node:fs/promises';
import { MODEL } from '../src/lib/model-info.js';
import { bringOptions, conditionWords } from '../src/lib/plan.js';
import { checkModelOutput } from '../src/lib/guard.js';

env.cacheDir = './.hf-cache/';
const ACT = { walk: 'a short walk', hike: 'a hike', garden: 'time in the garden' };
const F = (minTemp, maxTemp, maxPop, maxUv, maxWind, thunder = false) => ({ minTemp, maxTemp, maxPop, maxUv, maxWind, thunder });
const scenarios = [
  ['walk', F(14, 17, 10, 2, 12), 'autumn', 'afternoon'],
  ['hike', F(3, 8, 70, 1, 35), 'winter', 'morning'],
  ['garden', F(22, 29, 0, 8, 8), 'summer', 'midday'],
  ['walk', null, 'unknown', 'unknown'],
  ['hike', null, 'spring', 'morning'],
  ['garden', F(8, 12, 40, 3, 22), 'spring', 'morning'],
  ['walk', F(26, 33, 5, 9, 10), 'summer', 'evening'],
  ['hike', F(10, 16, 20, 5, 45), 'autumn', 'midday'],
  ['walk', F(-3, 2, 10, 1, 15), 'winter', 'afternoon'],
  ['garden', null, 'autumn', 'unknown'],
];
const gen = await pipeline('text-generation', MODEL.id, { dtype: MODEL.dtype });
const ask = async (content, max) => {
  const out = await gen([{ role: 'user', content }], { max_new_tokens: max, do_sample: false, repetition_penalty: 1.1 });
  return String(out?.[0]?.generated_text?.at(-1)?.content ?? '').trim();
};
const wl = (w) => (w ? `${w.temp}, ${w.rain}, ${w.sun}, ${w.wind}` : 'unknown');
const ctx = (a, w, s, p) => `${ACT[a]} on a ${w ? `${w.temp}, ${w.rain === 'dry' ? 'dry' : w.rain} ` : ''}${p === 'unknown' ? 'day' : p}${s === 'unknown' ? '' : ` in ${s}`}`;

const variants = {
  A_current: async (a, w, s, p, o) => ask([
    `Plan: ${ACT[a]} outside.`, `Weather: ${wl(w)}.`, `Season: ${s}. Time of day: ${p}.`,
    ...(o.required.length ? [`Already packed: ${o.required.map((r) => r.item).join(', ')}.`] : []),
    `Pick the three most useful things to bring from this list: ${o.optional.join(', ')}.`,
    'Then write one short sentence about one thing to look at or listen to outside, like a bird, a tree or the sky.',
    'Reply in exactly this format:', 'BRING: thing, thing, thing', 'NOTICE: sentence',
  ].join('\n'), 64),
  B_bullets: async (a, w, s, p, o) => ask([
    `Plan: ${ACT[a]} outside.`, `Weather: ${wl(w)}.`, `Season: ${s}. Time of day: ${p}.`,
    'Options to bring:', ...o.optional.map((x) => `- ${x}`),
    'Choose only three options. Then suggest one thing to look at or listen to outside.',
    'Answer with two lines:', 'BRING: <three options, separated by commas>', 'NOTICE: <one sentence>',
  ].join('\n'), 64),
  C_two_questions: async (a, w, s, p, o) => {
    const b = await ask(`Which three of these should I bring for ${ctx(a, w, s, p)}? ${o.optional.join(', ')}. Answer with the three items only, separated by commas.`, 24);
    const n = await ask(`Suggest one thing to look at or listen to during ${ctx(a, w, s, p)}. Answer in one short sentence.`, 40);
    return `BRING: ${b.replace(/\s*\n+\s*/g, ', ')}\nNOTICE: ${n.split('\n').find((l) => l.trim()) ?? ''}`;
  },
  D_two_questions_verb: async (a, w, s, p, o) => {
    const b = await ask(`I am going out for ${ctx(a, w, s, p)}. I can only carry three of these: ${o.optional.join(', ')}. Which three? Reply with just the three, separated by commas.`, 24);
    const n = await ask(`I am going out for ${ctx(a, w, s, p)}. Give me one small thing to notice outside, like a sound, a plant or the light. One short sentence that starts with Look, Listen or Find.`, 40);
    return `BRING: ${b.replace(/\s*\n+\s*/g, ', ')}\nNOTICE: ${n.split('\n').find((l) => l.trim()) ?? ''}`;
  },
};

const lines = ['## Prompt lab: Gemma 3 270M IT q4, 10 scenarios', ''];
const score = [];
for (const [name, fn] of Object.entries(variants)) {
  let b = 0; let n = 0; const rows = [];
  for (const [a, f, s, p] of scenarios) {
    const w = conditionWords(f);
    const o = bringOptions(a, w);
    const raw = await fn(a, w, s, p, o);
    const r = checkModelOutput(raw, { words: w, options: o.optional });
    if (r.bring.ok) b += 1;
    if (r.notice.ok) n += 1;
    rows.push(`- ${a} / ${w ? wl(w) : 'no weather'}: ${JSON.stringify(raw).slice(0, 260)} → bring ${r.bring.ok ? `ok ${r.bring.picks.join('|')}` : `NO (${r.bring.reason})`}; notice ${r.notice.ok ? 'ok' : `NO (${r.notice.reason})`}`);
  }
  score.push(`| ${name} | ${b}/10 | ${n}/10 |`);
  lines.push(`### ${name}: bring ${b}/10, notice ${n}/10`, '', ...rows, '');
}
const md = [...lines, '| variant | bring ok | notice ok |', '|---|---|---|', ...score, ''].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
