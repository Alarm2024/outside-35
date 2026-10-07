// The open-weight model, running in this browser tab with Transformers.js.
// Loaded only when the user asks. Weights come from the Hugging Face Hub once,
// then stay in this browser's Cache Storage, so it keeps working with no signal.

import { pipeline, env } from '@huggingface/transformers';
import { MODEL } from './lib/model-info.js';

env.allowLocalModels = false; // weights come from the Hub, then from the local cache
env.useBrowserCache = true;
// The service worker already keeps vendor/ort offline; do not store it twice.
env.useWasmCache = false;

function isOldSafari() {
  const ua = navigator.userAgent;
  if (!/Safari\//.test(ua) || /Chrome|Chromium|CriOS|Android|Edg/.test(ua)) return false;
  const m = ua.match(/Version\/(\d+)/);
  return m ? Number(m[1]) < 26 : false;
}

// ONNX Runtime's WASM files ship with this site (vendor/ort), not a CDN.
function useLocalRuntime(webgpu) {
  // Resolved from the page, not this file: after bundling, this code lives in chunks/.
  const base = new URL('vendor/ort/', document.baseURI).href;
  const suffix = isOldSafari() && !webgpu ? '' : '.asyncify';
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded${suffix}.mjs`,
    wasm: `${base}ort-wasm-simd-threaded${suffix}.wasm`,
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

let generator = null;
let device = null;

/** Is the model already in this browser's cache? */
export async function isCached() {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(env.cacheKey || 'transformers-cache');
    const url = `${env.remoteHost.replace(/\/$/, '')}/${MODEL.id}/resolve/main/onnx/${MODEL.file}`;
    return Boolean(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * @param {(p: {loaded?: number, total?: number, progress?: number, status: string}) => void} onProgress
 * @returns {Promise<{device: string}>}
 */
export async function loadModel(onProgress = () => {}) {
  if (generator) return { device };
  const webgpu = await hasWebGPU();
  const tryDevice = async (dev) => {
    useLocalRuntime(dev === 'webgpu');
    generator = await pipeline('text-generation', MODEL.id, {
      dtype: MODEL.dtype,
      device: dev,
      progress_callback: (p) => {
        if (p.status === 'progress_total' || p.status === 'ready') onProgress(p);
      },
    });
    device = dev;
  };
  if (webgpu) {
    try {
      await tryDevice('webgpu');
      return { device };
    } catch (err) {
      console.warn('WebGPU load failed, falling back to WASM', err);
      generator = null;
    }
  }
  await tryDevice('wasm');
  return { device };
}

export function modelDevice() {
  return device;
}

/** One short, greedy answer. Returns the raw text; the caller checks it. */
export async function generate(prompt, maxNewTokens = 64) {
  if (!generator) throw new Error('model not loaded');
  const out = await generator([{ role: 'user', content: prompt }], {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.1,
  });
  const last = out?.[0]?.generated_text;
  return Array.isArray(last) ? String(last.at(-1)?.content ?? '') : String(last ?? '');
}
