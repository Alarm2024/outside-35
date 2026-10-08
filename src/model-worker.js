// Gemma runs here, off the page's main thread. On the CPU one answer keeps the
// processor busy for seconds; in a worker the page still scrolls and taps.
// Each worker has its own ONNX Runtime, so moving from WebGPU to the CPU is a
// new worker, not a page reload.

import { AutoTokenizer, AutoModelForCausalLM, Tensor, env } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import { MODEL } from './lib/model-info.js';
import BASELINES from './lib/baselines.json';
import { makeLM, makeScorer, rank, rankingQuestions, rankShared, rankSteps } from './lib/rank.js';

env.allowLocalModels = false; // weights come from the Hub, then from the local cache
env.useBrowserCache = true;
// The service worker already keeps vendor/ort offline; do not store it twice.
env.useWasmCache = false;

// Which ONNX Runtime build runs the model. Measured, not assumed
// (scripts/probe-ort.mjs): the q4 weights use GatherBlockQuantized, which the
// "asyncify" build runs only on WebGPU and the plain build runs on the CPU.
const BUILD = { webgpu: '.asyncify', wasm: '' };

// Two tiny graphs (about 1 KB each) holding the q4 file's quantized operators.
// If this runtime cannot run them, it cannot run the model, and we say so
// before anyone downloads 344 MB.
const CHECK_GRAPHS = ['gather_block_quantized.onnx', 'matmul_nbits.onnx'];

let lm = null;
let score = null; // one full model run per answer
const baselines = new Map();

/**
 * The no-plan scores worked out once in CI with this exact model file (the
 * model check fails if they drift). Used on the CPU, where the two ways of
 * scoring give the same numbers; WebGPU works out its own.
 */
function shippedBaselines() {
  if (BASELINES.model !== MODEL.id || BASELINES.dtype !== MODEL.dtype) return;
  for (const [key, value] of Object.entries(BASELINES.scores)) baselines.set(key, value);
}
let base = '';
let device = null;

function useRuntime(dev, ortBase, build, threads) {
  const suffix = build ? { asyncify: '.asyncify', plain: '' }[build] : BUILD[dev];
  // More than one thread needs a cross-origin isolated page (see sw.js).
  // Measured on a copy of the model's largest layer with 4 cores: 3 to 4 times faster.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? threads || Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const paths = {
    mjs: `${ortBase}ort-wasm-simd-threaded${suffix}.mjs`,
    wasm: `${ortBase}ort-wasm-simd-threaded${suffix}.wasm`,
  };
  ort.env.wasm.wasmPaths = paths; // the same ONNX Runtime env Transformers.js uses
}

async function check() {
  for (const g of CHECK_GRAPHS) {
    const session = await ort.InferenceSession.create(`${base}ort-check/${g}`, { executionProviders: [device] });
    const feeds = {};
    for (const name of session.inputNames) {
      feeds[name] = name === 'idx'
        ? new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3])
        : new ort.Tensor('float32', new Float32Array(64).fill(0.5), [1, 64]);
    }
    await session.run(feeds);
    await session.release();
  }
}

async function load(id) {
  // One progress figure across every file (tokenizer, config, weights).
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, p);
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    self.postMessage({ id, type: 'progress', progress: (loaded / total) * 100 });
  };
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL.id, { progress_callback });
  const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype: MODEL.dtype, device, progress_callback });
  lm = makeLM(tokenizer, model, Tensor);
  score = makeScorer(tokenizer, model);
  if (device === 'wasm') shippedBaselines();
  // A session can load on a GPU and still fail on the first run; find out now.
  if (device === 'webgpu') await score('Hi', { prefix: '', text: 'Hello.' });
}

/**
 * Ranks this plan's Bring and Notice candidates, best first, reporting each
 * answer scored so the page can show progress.
 *
 * Each question's prompt is read once and its cache reused (rankShared):
 * measured in CI, the same scores as one full run per answer on the CPU. On
 * the CPU the prompt is read inside the shortest answer's run, one call fewer;
 * on WebGPU it runs on its own, because cutting a cache needs it in CPU
 * memory. On WebGPU (a software GPU in CI) every model call of 32 or more
 * new tokens gave other scores than the CPU (one full run per answer up to
 * 0.53 apart, and a long plan's prompt too), and every call of up to 27 the
 * same; so on WebGPU no call reads more than 16 new tokens at once (a long
 * prompt is read in pieces). mode 'full' keeps one full run per answer for
 * the bench; timings returns how long each model call took.
 */
async function rankPlan({ id, plan, bring, notice, mode = 'shared', timings = false }) {
  const q = rankingQuestions(plan);
  const total = rankSteps(q.bring, bring, baselines) + rankSteps(q.notice, notice, baselines);
  let done = 0;
  const onScored = () => self.postMessage({ id, type: 'progress', done: (done += 1), total });
  const calls = [];
  const timed = !timings ? lm : {
    ...lm,
    async run(ids, cache, keep) {
      const t = performance.now();
      const out = await lm.run(ids, cache, keep);
      calls.push({ tokens: ids.length, cached: cache ? cache.length : 0, ms: Math.round(performance.now() - t) });
      return out;
    },
  };
  const options = { promptInFirstAnswer: device === 'wasm', maxRun: device === 'wasm' ? 0 : 16 };
  const rankOne = mode === 'full'
    ? (question, candidates) => rank(score, question, candidates, baselines, onScored)
    : (question, candidates) => rankShared(timed, question, candidates, baselines, onScored, options);
  const ranked = { bring: await rankOne(q.bring, bring), notice: await rankOne(q.notice, notice) };
  return timings ? { ...ranked, calls } : ranked;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'init') {
      device = data.device;
      base = data.base;
      useRuntime(device, data.ortBase, data.build, data.threads);
      await check();
      self.postMessage({ id, type: 'done', threads: ort.env.wasm.numThreads, isolated: Boolean(self.crossOriginIsolated) });
    } else if (type === 'load') {
      await load(id);
      self.postMessage({ id, type: 'done' });
    } else if (type === 'rank') {
      if (!lm) throw new Error('model not loaded');
      self.postMessage({ id, type: 'done', ranked: await rankPlan(data) });
    } else if (type === 'forget') {
      // The bench times each way from scratch, with or without the shipped scores.
      baselines.clear();
      if (data.shipped) shippedBaselines();
      self.postMessage({ id, type: 'done', baselines: baselines.size });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
