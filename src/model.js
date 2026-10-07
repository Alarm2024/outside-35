// The open-weight model, loaded only when the user asks. It runs in a Web
// Worker (src/model-worker.js). Weights come from the Hugging Face Hub once,
// then stay in this browser's Cache Storage, so it keeps working with no signal.

// Set when WebGPU failed on this device, so the next load goes straight to the CPU.
const CPU_ONLY_KEY = 'o35:cpu-only';

async function hasWebGPU() {
  try {
    if (!('gpu' in navigator)) return false;
    return Boolean(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * ?device=wasm or ?device=webgpu forces one, and ?build=asyncify or ?build=plain
 * forces the runtime build (both for testing); otherwise WebGPU if it works here.
 */
function forcedBuild() {
  const b = new URLSearchParams(location.search).get('build');
  return b === 'asyncify' || b === 'plain' ? b : null;
}

async function pickDevice() {
  const forced = new URLSearchParams(location.search).get('device');
  if (forced === 'wasm' || forced === 'webgpu') return { dev: forced, forced: true };
  try {
    if (localStorage.getItem(CPU_ONLY_KEY)) return { dev: 'wasm', forced: false };
  } catch { /* no storage: just try WebGPU again */ }
  return { dev: (await hasWebGPU()) ? 'webgpu' : 'wasm', forced: false };
}

let worker = null;
let device = null;
let fellBack = false;
let seq = 0;
const pending = new Map();

function startWorker() {
  // Resolved from the page, not this file: after bundling, this code lives in chunks/.
  const w = new Worker(new URL('model-worker.js', document.baseURI), { type: 'module' });
  w.onmessage = ({ data }) => {
    const call = pending.get(data.id);
    if (!call) return;
    if (data.type === 'progress') {
      call.onProgress(data);
      return;
    }
    pending.delete(data.id);
    if (data.type === 'error') call.reject(new Error(data.message));
    else call.resolve(data);
  };
  w.onerror = (e) => {
    e.preventDefault();
    for (const call of pending.values()) call.reject(new Error(e.message || 'the model worker stopped'));
    pending.clear();
  };
  return w;
}

function call(w, msg, onProgress = () => {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ ...msg, id });
  });
}

/**
 * Checks this browser can run the model's operators (two tiny graphs, no
 * download), then loads it. WebGPU first when the device has it; if WebGPU
 * fails, a fresh worker tries the CPU, with the weights already cached.
 * @param {(p: {progress?: number|null}) => void} onProgress
 * @param {(stage: 'checking'|'downloading') => void} onStage
 * @returns {Promise<{device: string, fellBack: boolean}>}
 */
export async function loadModel(onProgress = () => {}, onStage = () => {}) {
  if (device) return { device, fellBack };
  const { dev, forced } = await pickDevice();
  const tryDevice = async (d) => {
    const w = startWorker();
    try {
      onStage('checking');
      await call(w, { type: 'init', device: d, build: forcedBuild(), base: new URL('./', document.baseURI).href, ortBase: new URL('vendor/ort/', document.baseURI).href });
      onStage('downloading');
      await call(w, { type: 'load' }, onProgress);
      return w;
    } catch (err) {
      w.terminate();
      throw err;
    }
  };
  try {
    worker = await tryDevice(dev);
    device = dev;
  } catch (err) {
    // A failed download is not a GPU problem; only a runtime error moves us to the CPU.
    const gpuFault = /session|ERROR_CODE|OrtRun|webgpu|gpu|shader|adapter|backend/i.test(err.message);
    if (dev !== 'webgpu' || forced || !gpuFault) throw err;
    try { localStorage.setItem(CPU_ONLY_KEY, '1'); } catch { /* not saved */ }
    worker = await tryDevice('wasm');
    device = 'wasm';
    fellBack = true;
  }
  return { device, fellBack };
}

export function modelDevice() {
  return device;
}

/**
 * Ranks human-written candidates for this plan, best first.
 * @returns {Promise<{bring: {c: string, score: number}[], notice: {c: string, score: number}[]}>}
 */
export async function rankPlan(plan, bring, notice) {
  if (!worker || !device) throw new Error('model not loaded');
  return (await call(worker, { type: 'rank', plan, bring, notice })).ranked;
}
