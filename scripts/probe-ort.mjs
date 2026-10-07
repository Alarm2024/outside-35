// Which ONNX Runtime build can run the q4 model's quantized operators, on which
// backend, in headless Chromium. Uses the runtime files the site ships
// (dist/vendor/ort) and the tiny graphs in test/fixtures/ort, so it answers in
// seconds without the 344 MB model.
//
//   npm run build && npm run probe-ort
//
// The app depends on two answers, and this fails if either changes:
//   - plain build on the CPU runs every operator (phones without WebGPU)
//   - asyncify build on WebGPU runs every operator (SwiftShader's software GPU here)
// It also reports asyncify on the CPU, which cannot run GatherBlockQuantized
// today. That is why the app never falls back to the CPU in the same page.
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ortPackage } from './pkg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ort } = await ortPackage(import.meta.url);
const fixtures = path.join(root, 'test', 'fixtures', 'ort');
const graphs = (await readdir(fixtures)).filter((f) => f.endsWith('.onnx')).sort();

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = p === '/' ? null
    : p === '/ort.mjs' ? path.join(ort.dir, 'dist', 'ort.webgpu.bundle.min.mjs')
      : p.startsWith('/vendor/ort/') ? path.join(root, 'dist', p)
        : path.join(fixtures, path.basename(p));
  const type = !file ? 'text/html' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
  let body;
  try { body = file ? await readFile(file) : '<!doctype html><title>probe</title>'; } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': type });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // A software WebGPU adapter, so the WebGPU path can be tested without a GPU.
  args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});

async function probe(build, ep) {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async ({ base, build, ep, graphs }) => {
    if (ep === 'webgpu' && !(navigator.gpu && (await navigator.gpu.requestAdapter()))) return { skipped: 'no WebGPU adapter' };
    const ort = await import(`${base}ort.mjs`);
    const sfx = build === 'plain' ? '' : `.${build}`;
    ort.env.wasm.wasmPaths = { mjs: `${base}vendor/ort/ort-wasm-simd-threaded${sfx}.mjs`, wasm: `${base}vendor/ort/ort-wasm-simd-threaded${sfx}.wasm` };
    ort.env.wasm.numThreads = 1;
    const out = {};
    for (const g of graphs) {
      try {
        const s = await ort.InferenceSession.create(`${base}${g}`, { executionProviders: [ep] });
        const feeds = {};
        for (const n of s.inputNames) {
          feeds[n] = n === 'idx'
            ? new ort.Tensor('int64', BigInt64Array.from([1n, 2n, 3n]), [1, 3])
            : new ort.Tensor('float32', new Float32Array(64).fill(0.5), [1, 64]);
        }
        const r = await s.run(feeds);
        out[g] = Array.from(r.y.data).every(Number.isFinite) ? 'ok' : 'ran, but not finite';
      } catch (e) {
        out[g] = String(e.message || e).replace(/\s+/g, ' ').slice(0, 140);
      }
    }
    return { out };
  }, { base, build, ep, graphs });
  await page.close();
  return result;
}

const cases = [
  { build: 'plain', ep: 'wasm', need: true, use: 'the app on the CPU' },
  { build: 'asyncify', ep: 'webgpu', need: true, use: 'the app on WebGPU' },
  { build: 'asyncify', ep: 'wasm', need: false, use: 'not used: cannot run GatherBlockQuantized' },
];
const lines = ['## ONNX Runtime operator probe', '', `onnxruntime-web ${ort.version}, ${graphs.length} graphs: ${graphs.join(', ')}`, ''];
let failed = false;
for (const c of cases) {
  const r = await probe(c.build, c.ep);
  const bad = r.out ? Object.entries(r.out).filter(([, v]) => v !== 'ok') : [];
  const verdict = r.skipped ? `skipped (${r.skipped})` : bad.length ? `${bad.length} failed` : 'all ok';
  lines.push(`- **${c.build} on ${c.ep}** (${c.use}): ${verdict}`);
  for (const [g, v] of bad) lines.push(`  - ${g}: ${v}`);
  if (c.need && (r.skipped || bad.length)) failed = true;
  if (!c.need && r.out && !bad.length) lines.push('  - it runs everything now: the CPU could use the asyncify build too, and the reload could go');
}
await browser.close();
server.close();
const text = `${lines.join('\n')}\n`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
if (failed) {
  console.error('probe-ort: a build the app depends on cannot run the model\'s operators');
  process.exit(1);
}
