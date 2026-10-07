// The open-weight model, running in this browser tab with Transformers.js.
// Loaded only when the user asks. Weights come from the Hugging Face Hub once,
// then stay in this browser's Cache Storage, so it keeps working with no signal.

import { pipeline, env } from '@huggingface/transformers';
import { MODEL, GENERATION } from './lib/model-info.js';

env.allowLocalModels = false; // weights come from the Hub, then from the local cache
env.useBrowserCache = true;
// The service worker already keeps vendor/ort offline; do not store it twice.
env.useWasmCache = false;

// Which ONNX Runtime build runs the model. Measured, not assumed
// (scripts/probe-ort.mjs): the q4 weights use GatherBlockQuantized, which the
// "asyncify" build runs only on WebGPU, and the plain build runs on the CPU.
// The plain build has no WebGPU, so the choice is made once, before loading.
const BUILD = { webgpu: '.asyncify', wasm: '' };

// Set when WebGPU failed on this device, so the next load goes straight to the CPU.
const CPU_ONLY_KEY = 'o35:cpu-only';

function useLocalRuntime(device) {
  // Resolved from the page, not this file: after bundling, this code lives in chunks/.
  const base = new URL('vendor/ort/', document.baseURI).href;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded${BUILD[device]}.mjs`,
    wasm: `${base}ort-wasm-simd-threaded${BUILD[device]}.wasm`,
  };
}

async function hasWebGPU() {
  try {
    if (!('gpu' in navigator)) return false;
    return Boolean(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** ?device=wasm or ?device=webgpu forces one (for testing); otherwise WebGPU if it works here. */
async function pickDevice() {
  const forced = new URLSearchParams(location.search).get('device');
  if (forced === 'wasm' || forced === 'webgpu') return { dev: forced, forced: true };
  try {
    if (localStorage.getItem(CPU_ONLY_KEY)) return { dev: 'wasm', forced: false };
  } catch { /* no storage: just try WebGPU again */ }
  return { dev: (await hasWebGPU()) ? 'webgpu' : 'wasm', forced: false };
}

let generator = null;
let device = null;

/**
 * @param {(p: {loaded?: number, total?: number, progress?: number, status: string}) => void} onProgress
 * @returns {Promise<{device: string}>}
 * If WebGPU fails, this throws an error with `useCpu = true`: the runtime is
 * already set up for WebGPU in this page, so the CPU needs a page reload.
 */
export async function loadModel(onProgress = () => {}) {
  if (generator) return { device };
  const { dev, forced } = await pickDevice();
  useLocalRuntime(dev);
  try {
    generator = await pipeline('text-generation', MODEL.id, {
      dtype: MODEL.dtype,
      device: dev,
      progress_callback: (p) => {
        if (p.status === 'progress_total' || p.status === 'ready') onProgress(p);
      },
    });
    // A session can load on a GPU and still fail on the first run; find out now.
    if (dev === 'webgpu') await generator([{ role: 'user', content: 'Hi' }], { max_new_tokens: 1 });
  } catch (err) {
    generator = null;
    // A failed download is not a GPU problem; only a runtime error moves us to the CPU.
    const gpuFault = /session|ERROR_CODE|OrtRun|webgpu|gpu|shader|adapter/i.test(String(err && err.message));
    if (dev === 'webgpu' && !forced && gpuFault) {
      try { localStorage.setItem(CPU_ONLY_KEY, '1'); } catch { /* not saved */ }
      const e = new Error(`WebGPU did not work here (${err.message})`);
      e.useCpu = true;
      throw e;
    }
    throw err;
  }
  device = dev;
  return { device };
}

export function modelDevice() {
  return device;
}

/** One short, greedy answer. Returns the raw text; the caller checks it. */
export async function generate(prompt) {
  if (!generator) throw new Error('model not loaded');
  const out = await generator([{ role: 'user', content: prompt }], GENERATION);
  const last = out?.[0]?.generated_text;
  return Array.isArray(last) ? String(last.at(-1)?.content ?? '') : String(last ?? '');
}
