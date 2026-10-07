// Runs the real open-weight model (Gemma 3 270M IT, q4) with the exact prompt
// builder and never-guess check the web app uses, and reports what happened.
// Runs in CI (GitHub Actions), where the Hugging Face Hub is reachable.
//
//   npm ci && npm run model-check
//
// Exit code 1 if the model cannot load, or if every answer fails the check.
import { pipeline, env } from '@huggingface/transformers';
import { appendFile, writeFile } from 'node:fs/promises';
import { MODEL, GENERATION } from '../src/lib/model-info.js';
import { buildPrompt, bringOptions, conditionWords, requiredLabel } from '../src/lib/plan.js';
import { checkModelOutput } from '../src/lib/guard.js';

const scenarios = [
  { activity: 'walk', facts: { minTemp: 14, maxTemp: 17, maxPop: 10, maxUv: 2, maxWind: 12, thunder: false }, seasonName: 'autumn', part: 'afternoon' },
  { activity: 'hike', facts: { minTemp: 3, maxTemp: 8, maxPop: 70, maxUv: 1, maxWind: 35, thunder: false }, seasonName: 'winter', part: 'morning' },
  { activity: 'garden', facts: { minTemp: 22, maxTemp: 29, maxPop: 0, maxUv: 8, maxWind: 8, thunder: false }, seasonName: 'summer', part: 'midday' },
  { activity: 'walk', facts: null, seasonName: 'unknown', part: 'unknown' },
  { activity: 'hike', facts: null, seasonName: 'spring', part: 'morning' },
];

env.cacheDir = './.hf-cache/'; // cached between CI runs

const t0 = Date.now();
let generator;
try {
  generator = await pipeline('text-generation', MODEL.id, { dtype: MODEL.dtype });
} catch (err) {
  console.error(`model failed to load: ${err.message}`);
  process.exit(1);
}
const loadSecs = ((Date.now() - t0) / 1000).toFixed(1);

const rows = [];
for (const s of scenarios) {
  const words = conditionWords(s.facts);
  const options = bringOptions(s.activity, words);
  const prompt = buildPrompt({ activity: s.activity, words, seasonName: s.seasonName, part: s.part, options });
  const t = Date.now();
  const out = await generator([{ role: 'user', content: prompt }], GENERATION);
  const raw = String(out?.[0]?.generated_text?.at(-1)?.content ?? '');
  const check = checkModelOutput(raw, { words, options: options.optional });
  const shown = check.ok ? [...options.required.map(requiredLabel), ...check.picks].join(', ') : '';
  rows.push({ s, words, raw, check, shown, secs: ((Date.now() - t) / 1000).toFixed(1) });
}

const accepted = rows.filter((r) => r.check.ok).length;
const esc = (x) => String(x).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
const md = [
  `## Model check: ${MODEL.name} (${MODEL.dtype}), ${MODEL.id}`,
  '',
  `Loaded in ${loadSecs} s on the CI runner's CPU. ${accepted} of ${rows.length} answers passed the never-guess check.`,
  '',
  '| plan | weather words given | model answer | check | bring shown |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.s.activity} | ${r.words ? esc(Object.values(r.words).join(', ')) : 'none (weather UNKNOWN)'} | ${esc(r.raw)} | ${r.check.ok ? `used${r.check.dropped.length ? `, dropped ${esc(r.check.dropped.join(', '))}` : ''}` : `discarded: ${esc(r.check.reason)}`} (${r.secs} s) | ${esc(r.shown || 'built-in text')} |`),
  '',
].join('\n');

console.log(md);
await writeFile('model-check.md', md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
if (accepted === 0) {
  console.error('every answer failed the never-guess check');
  process.exit(1);
}
