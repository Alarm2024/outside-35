// Browser bench, built only for CI (BENCH=1 npm run build) and never deployed.
// The app's own worker times each plan from test/scenarios.mjs, one way after
// the other: ?runs=full:2,shared:6 is the old way (one full model run per
// answer) on two plans, then the app's way on six. Results go to window.bench.
import { bringOptions, noticeOptions } from '../src/lib/plan.js';
import { describePlan } from '../src/lib/rank.js';
import { SCENARIOS, scenarioPlan } from '../test/scenarios.mjs';

const params = new URLSearchParams(location.search);
const device = params.get('device') === 'webgpu' ? 'webgpu' : 'wasm';
const runs = (params.get('runs') || 'shared:6').split(',').map((r) => {
  const [mode, n] = r.split(':');
  return { mode, n: Number(n) };
});

const worker = new Worker(new URL('model-worker.js', document.baseURI), { type: 'module' });
const pending = new Map();
let seq = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p || data.type === 'progress') return;
  pending.delete(data.id);
  if (data.type === 'error') p.reject(new Error(data.message));
  else p.resolve(data);
};
const call = (msg) => new Promise((resolve, reject) => {
  const id = (seq += 1);
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id });
});

window.bench = { done: false };
try {
  await call({ type: 'init', device, build: null, base: new URL('./', document.baseURI).href, ortBase: new URL('vendor/ort/', document.baseURI).href });
  await call({ type: 'load' });
  const rows = [];
  for (const { mode, n } of runs) {
    await call({ type: 'forget' });
    for (const s of SCENARIOS.slice(0, n)) {
      const plan = scenarioPlan(s);
      const t = performance.now();
      const { ranked } = await call({ type: 'rank', mode, plan, bring: bringOptions(s.activity, plan.words).optional, notice: noticeOptions(plan) });
      rows.push({ mode, plan: describePlan(plan), secs: (performance.now() - t) / 1000, ranked });
    }
  }
  window.bench = { done: true, device, rows };
} catch (err) {
  window.bench = { done: true, device, error: String((err && err.message) || err) };
}
