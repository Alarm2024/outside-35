// Gemma runs here, off the page's main thread. On the CPU one answer keeps the
// processor busy for seconds; in a worker the page still scrolls and taps.
// Each worker has its own ONNX Runtime, so moving from WebGPU to the CPU is a
// new worker, not a page reload.

import { AutoTokenizer, AutoModelForCausalLM, env } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import { MODEL } from './lib/model-info.js';
import { makeScorer, rank, rankingQuestions } from './lib/rank.js';

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

let score = null;
const baselines = new Map();
let base = '';
let device = null;

function useRuntime(dev, ortBase, build) {
  const suffix = build ? { asyncify: '.asyncify', plain: '' }[build] : BUILD[dev];
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
  score = makeScorer(tokenizer, model);
  // A session can load on a GPU and still fail on the first run; find out now.
  if (device === 'webgpu') await score('Hi', { prefix: '', text: 'Hello.' });
}

/** Ranks this plan's Bring and Notice candidates, best first. */
async function rankPlan({ plan, bring, notice }) {
  const q = rankingQuestions(plan);
  return { bring: await rank(score, q.bring, bring, baselines), notice: await rank(score, q.notice, notice, baselines) };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'init') {
      device = data.device;
      base = data.base;
      useRuntime(device, data.ortBase, data.build);
      await check();
      self.postMessage({ id, type: 'done' });
    } else if (type === 'load') {
      await load(id);
      self.postMessage({ id, type: 'done' });
    } else if (type === 'rank') {
      if (!score) throw new Error('model not loaded');
      self.postMessage({ id, type: 'done', ranked: await rankPlan(data) });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
