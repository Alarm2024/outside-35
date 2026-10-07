// Runs the real open-weight model (Gemma 3 270M IT, q4) with the exact ranking
// code the web app uses (src/lib/rank.js), on the app's own option lists, and
// reports what it chose. Runs in CI (GitHub Actions), where the Hugging Face
// Hub is reachable.
//
//   npm ci && npm run model-check
//
// Exit code 1 if the model cannot load, a score is not a number, or the
// choices do not change with the plan (a scorer that ignores the plan is broken).
import { AutoTokenizer, AutoModelForCausalLM, env } from '@huggingface/transformers';
import { appendFile, writeFile } from 'node:fs/promises';
import { MODEL } from '../src/lib/model-info.js';
import { bringOptions, conditionWords, noticeOptions, requiredLabel } from '../src/lib/plan.js';
import { describePlan, makeScorer, rank, rankingQuestions } from '../src/lib/rank.js';

const F = (minTemp, maxTemp, maxPop, maxUv, maxWind, thunder = false) => ({ minTemp, maxTemp, maxPop, maxUv, maxWind, thunder });
const scenarios = [
  { activity: 'walk', facts: F(14, 17, 10, 2, 12), seasonName: 'autumn', part: 'afternoon' },
  { activity: 'hike', facts: F(3, 8, 70, 1, 35), seasonName: 'winter', part: 'morning' },
  { activity: 'garden', facts: F(22, 29, 0, 8, 8), seasonName: 'summer', part: 'midday' },
  { activity: 'walk', facts: null, seasonName: 'unknown', part: 'unknown' },
  { activity: 'hike', facts: null, seasonName: 'spring', part: 'morning' },
  { activity: 'walk', facts: F(-3, 2, 10, 1, 15), seasonName: 'winter', part: 'afternoon' },
];

env.cacheDir = './.hf-cache/'; // cached between CI runs

const t0 = Date.now();
let score;
try {
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL.id);
  const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype: MODEL.dtype });
  score = makeScorer(tokenizer, model);
} catch (err) {
  console.error(`model failed to load: ${err.message}`);
  process.exit(1);
}
const loadSecs = ((Date.now() - t0) / 1000).toFixed(1);

const baselines = new Map();
const rows = [];
for (const s of scenarios) {
  const words = conditionWords(s.facts);
  const plan = { activity: s.activity, words, seasonName: s.seasonName, part: s.part };
  const options = bringOptions(s.activity, words);
  const q = rankingQuestions(plan);
  const t = Date.now();
  const bring = await rank(score, q.bring, options.optional, baselines);
  const notice = await rank(score, q.notice, noticeOptions(plan), baselines);
  rows.push({ plan, options, bring, notice, secs: ((Date.now() - t) / 1000).toFixed(1) });
}

const finite = rows.every((r) => [...r.bring, ...r.notice].every((x) => Number.isFinite(x.score)));
const distinct = new Set(rows.map((r) => `${r.bring.slice(0, 3).map((x) => x.c)}|${r.notice[0].c}`)).size;
const esc = (x) => String(x).replace(/\|/g, '\\|');
const md = [
  `## Model check: ${MODEL.name} (${MODEL.dtype}), ${MODEL.id}`,
  '',
  `Loaded in ${loadSecs} s on the CI runner's CPU. The model ranks lines people wrote; the data decides which lines are allowed. ${distinct} different choices across ${rows.length} plans.`,
  '',
  '| plan | must bring (code) | model\'s top three to bring | model\'s Notice | time |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${esc(describePlan(r.plan))} | ${esc(r.options.required.map(requiredLabel).join(', ') || 'nothing extra')} | ${esc(r.bring.slice(0, 3).map((x) => x.c).join(', '))} | ${esc(r.notice[0].c)} | ${r.secs} s |`),
  '',
].join('\n');

console.log(md);
await writeFile('model-check.md', md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
if (!finite) {
  console.error('a score was not a number');
  process.exit(1);
}
if (distinct < 3) {
  console.error('the choices barely change with the plan, so the ranking is not using it');
  process.exit(1);
}
