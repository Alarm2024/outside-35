// Browser bench, built only for CI (BENCH=1 npm run build) and never deployed.
// The app's own worker times each plan from test/scenarios.mjs. ?runs= is a
// JSON list of runs: { label, mode: 'full' | 'shared', from = 0, n, threads
// (default: as the app), shipped (start from the shipped no-plan scores),
// allNotices (every allowed Notice line, as before the cap of six) }.
// Results go to window.bench.
import { bringOptions, noticeOptions } from '../src/lib/plan.js';
import { describePlan } from '../src/lib/rank.js';
import { SCENARIOS, scenarioPlan } from '../test/scenarios.mjs';

const params = new URLSearchParams(location.search);
const device = params.get('device') === 'webgpu' ? 'webgpu' : 'wasm';
const runs = JSON.parse(params.get('runs') || '[{"label":"the app","mode":"shared","n":6,"shipped":true}]');

let worker = null;
let workerThreads;
const pending = new Map();
let seq = 0;
const call = (msg) => new Promise((resolve, reject) => {
  const id = (seq += 1);
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id });
});

/** One ONNX Runtime per worker, and its thread count is fixed at start. */
async function workerWith(threads) {
  if (worker && workerThreads === threads) return;
  if (worker) worker.terminate();
  worker = new Worker(new URL('model-worker.js', document.baseURI), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p || data.type === 'progress') return;
    pending.delete(data.id);
    if (data.type === 'error') p.reject(new Error(data.message));
    else p.resolve(data);
  };
  workerThreads = threads;
  const init = await call({ type: 'init', device, build: null, threads, base: new URL('./', document.baseURI).href, ortBase: new URL('vendor/ort/', document.baseURI).href });
  await call({ type: 'load' });
  return init;
}

window.bench = { done: false };
try {
  const rows = [];
  let threadsNow = null;
  for (const run of runs) {
    const init = await workerWith(run.threads ?? null);
    if (init) threadsNow = init.threads;
    await call({ type: 'forget', shipped: Boolean(run.shipped) });
    const from = run.from ?? 0;
    for (const s of SCENARIOS.slice(from, from + run.n)) {
      const plan = scenarioPlan(s);
      const t = performance.now();
      const notice = noticeOptions(plan, run.allNotices ? { max: Infinity } : {});
      const { ranked } = await call({ type: 'rank', mode: run.mode, plan, bring: bringOptions(s.activity, plan.words).optional, notice });
      rows.push({ label: run.label, mode: run.mode, threads: threadsNow, plan: describePlan(plan), secs: (performance.now() - t) / 1000, ranked });
    }
  }
  window.bench = { done: true, device, isolated: self.crossOriginIsolated, rows };
} catch (err) {
  window.bench = { done: true, device, error: String((err && err.message) || err) };
}
