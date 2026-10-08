// Runs the real open-weight model (Gemma 3 270M IT, q4) with the exact ranking
// code the web app uses (src/lib/rank.js), on the app's own option lists, and
// reports what it chose and how long each plan took. Runs in CI (GitHub
// Actions), where the Hugging Face Hub is reachable.
//
//   npm ci && npm run model-check
//
// It times two ways of scoring the same lists. Before: one full model run per
// answer (makeScorer). After, the app's way: each question's prompt runs once
// and its cache is reused (rankShared). Both must give the same scores.
// It also works out every no-plan score and checks src/lib/baselines.json, which
// the app ships for the CPU, against them (npm run baselines rewrites it).
// Exit code 1 if the model cannot load, a score is not a number, the two ways
// disagree, the shipped no-plan scores are out of date, or the choices do not
// change with the plan (a scorer that ignores the plan is broken).
import { AutoTokenizer, AutoModelForCausalLM, Tensor, env } from '@huggingface/transformers';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { MODEL } from '../src/lib/model-info.js';
import { allCandidates, bringOptions, noticeOptions, requiredLabel } from '../src/lib/plan.js';
import { describePlan, makeLM, makeScorer, rank, rankingQuestions, rankShared, scoreShared } from '../src/lib/rank.js';
import { SCENARIOS, scenarioPlan } from '../test/scenarios.mjs';

// The two ways may differ only by float rounding.
const SAME = 1e-3;
// The shipped no-plan scores must match this run (the same kernels each time).
const SHIPPED_SAME = 1e-4;
const BASELINES_FILE = new URL('../src/lib/baselines.json', import.meta.url);
const WRITE = process.argv.includes('--write-baselines');

env.cacheDir = './.hf-cache/'; // cached between CI runs

const t0 = Date.now();
let tokenizer;
let model;
try {
  tokenizer = await AutoTokenizer.from_pretrained(MODEL.id);
  model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype: MODEL.dtype });
} catch (err) {
  console.error(`model failed to load: ${err.message}`);
  process.exit(1);
}
const loadSecs = ((Date.now() - t0) / 1000).toFixed(1);
const inputs = model.sessions.model.inputNames;
const keepsRows = inputs.includes('num_logits_to_keep');

const score = makeScorer(tokenizer, model);
const lm = makeLM(tokenizer, model, Tensor);
// One small run each, so neither way pays first-run costs inside its timing.
await score('Hi', { prefix: '', text: 'Hello.' });
await scoreShared(lm, 'Hi', [{ prefix: '', text: 'Hello.' }]);

/** Ranks all six plans one way, from no stored no-plan scores. */
async function rankAll(rankOne) {
  const baselines = new Map();
  const rows = [];
  for (const s of SCENARIOS) {
    const plan = scenarioPlan(s);
    const options = bringOptions(s.activity, plan.words);
    const q = rankingQuestions(plan);
    const t = performance.now();
    const bring = await rankOne(q.bring, options.optional, baselines);
    const notice = await rankOne(q.notice, noticeOptions(plan), baselines);
    rows.push({ plan, options, bring, notice, secs: (performance.now() - t) / 1000 });
  }
  return { rows, baselines };
}
const before = await rankAll((q, c, b) => rank(score, q, c, b));
const after = await rankAll((q, c, b) => rankShared(lm, q, c, b));

let maxDiff = 0;
after.rows.forEach((r, i) => {
  for (const list of ['bring', 'notice']) {
    for (const x of r[list]) {
      const old = before.rows[i][list].find((y) => y.c === x.c);
      maxDiff = Math.max(maxDiff, Math.abs(x.score - old.score));
    }
  }
});

const rows = after.rows;
const finite = rows.every((r) => [...r.bring, ...r.notice].every((x) => Number.isFinite(x.score)));
const distinct = new Set(rows.map((r) => `${r.bring.slice(0, 3).map((x) => x.c)}|${r.notice[0].c}`)).size;
const sum = (rs) => rs.reduce((t, r) => t + r.secs, 0);
const esc = (x) => String(x).replace(/\|/g, '\\|');
const md = [
  `## Model check: ${MODEL.name} (${MODEL.dtype}), ${MODEL.id}`,
  '',
  `Loaded in ${loadSecs} s on the CI runner's CPU (Node, native ONNX Runtime). The model ranks lines people wrote; the data decides which lines are allowed. ${distinct} different choices across ${rows.length} plans.`,
  '',
  '| plan | must bring (code) | model\'s top three to bring | model\'s Notice | before | after |',
  '|---|---|---|---|---|---|',
  ...rows.map((r, i) => `| ${esc(describePlan(r.plan))} | ${esc(r.options.required.map(requiredLabel).join(', ') || 'nothing extra')} | ${esc(r.bring.slice(0, 3).map((x) => x.c).join(', '))} | ${esc(r.notice[0].c)} | ${before.rows[i].secs.toFixed(1)} s | ${r.secs.toFixed(1)} s |`),
  '',
  `Before: one full model run per answer. After (what the app runs): each question's prompt runs once and its cache is reused, so each answer costs only its own tokens${keepsRows ? ', and the model returns logits only for the rows that are read (num_logits_to_keep)' : '; this model file has no num_logits_to_keep input, so every run returns logits for all its tokens'}. The first plan also works out the no-plan scores. Total ${sum(before.rows).toFixed(1)} s before, ${sum(after.rows).toFixed(1)} s after. Largest score difference between the two ways: ${maxDiff.toExponential(1)} (allowed: ${SAME}).`,
  '',
].join('\n');

console.log(md);
await writeFile('model-check.md', md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);

// Every no-plan score any plan can need. The app ships them for the CPU
// (src/lib/baselines.json); this checks that file is current.
const all = allCandidates();
const q0 = rankingQuestions(scenarioPlan(SCENARIOS[0]));
const neutral = {};
for (const [q, list] of [[q0.bring, all.bring], [q0.notice, all.notice]]) {
  const answers = list.map(q.answer);
  const s = await scoreShared(lm, q.neutral, answers);
  answers.forEach((a, i) => { neutral[`${q.neutral}\n${a.prefix}${a.text}`] = s[i]; });
}
const shipped = JSON.parse(await readFile(BASELINES_FILE, 'utf8'));
if (WRITE) {
  shipped.model = MODEL.id;
  shipped.dtype = MODEL.dtype;
  shipped.scores = neutral;
  await writeFile(BASELINES_FILE, `${JSON.stringify(shipped, null, 2)}\n`);
  console.log(`wrote ${Object.keys(neutral).length} no-plan scores to src/lib/baselines.json`);
}
const keys = Object.keys(neutral);
const missing = keys.filter((k) => !(k in shipped.scores));
const extra = Object.keys(shipped.scores).filter((k) => !(k in neutral));
const shippedDiff = Math.max(0, ...keys.filter((k) => k in shipped.scores).map((k) => Math.abs(neutral[k] - shipped.scores[k])));
const shippedLine = `Shipped no-plan scores (src/lib/baselines.json, used on the CPU): ${keys.length - missing.length} of ${keys.length} present, largest difference from this run ${shippedDiff.toExponential(1)} (allowed: ${SHIPPED_SAME}).`;
console.log(`${shippedLine}\nmodel inputs: ${inputs.join(', ')}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${shippedLine}\n`);

if (!finite) {
  console.error('a score was not a number');
  process.exit(1);
}
if (!(maxDiff <= SAME)) {
  console.error(`the shared-prompt scores differ from the full-run scores by ${maxDiff}`);
  process.exit(1);
}
if (missing.length || extra.length || shipped.model !== MODEL.id || shipped.dtype !== MODEL.dtype || !(shippedDiff <= SHIPPED_SAME)) {
  console.error(`src/lib/baselines.json is out of date (${missing.length} missing, ${extra.length} extra, largest difference ${shippedDiff}): run npm run baselines`);
  process.exit(1);
}
if (distinct < 3) {
  console.error('the choices barely change with the plan, so the ranking is not using it');
  process.exit(1);
}
