// Build the static site into dist/: bundle the app (the model code is a
// separate chunk, loaded only on demand), copy ONNX Runtime's WASM so nothing
// comes from a CDN, and stamp the service worker with a version and file list.
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ortPackage } from './pkg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

function version() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return `local-${Date.now()}`;
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'vendor', 'ort'), { recursive: true });

await build({
  // The model runs in its own worker (model-worker.js), off the page's main thread.
  entryPoints: [path.join(src, 'app.js'), path.join(src, 'model-worker.js')],
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: ['es2022'],
  outdir: dist,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  legalComments: 'linked',
  logLevel: 'warning',
});

for (const f of ['index.html', 'styles.css', 'manifest.webmanifest']) {
  await cp(path.join(src, f), path.join(dist, f));
}
await cp(path.join(src, 'icons'), path.join(dist, 'icons'), { recursive: true });
// Two ~1 KB graphs with the model's quantized operators: the worker runs them
// before the 344 MB download, so a browser that cannot run Gemma says so first.
await mkdir(path.join(dist, 'ort-check'), { recursive: true });
for (const f of ['gather_block_quantized.onnx', 'matmul_nbits.onnx']) {
  await cp(path.join(root, 'test', 'fixtures', 'ort', f), path.join(dist, 'ort-check', f));
}
await cp(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE.txt'));
await writeFile(path.join(dist, '.nojekyll'), '');

// ONNX Runtime Web, the exact version Transformers.js depends on.
const { tjs, ort } = await ortPackage(import.meta.url);
const ortVersion = ort.version;
const ortDist = path.join(ort.dir, 'dist');
// asyncify: WebGPU. Plain: the CPU (see scripts/probe-ort.mjs for why both).
const ortFiles = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
for (const f of ortFiles) await cp(path.join(ortDist, f), path.join(dist, 'vendor', 'ort', f));

// Everything except the big vendor files is precached by the service worker.
async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel !== 'vendor') out.push(...(await walk(path.join(dir, e.name), rel)));
    } else if (!e.name.startsWith('.') && !e.name.endsWith('.map') && e.name !== 'sw.js') {
      out.push(`./${rel}`);
    }
  }
  return out;
}
const precache = ['./', ...(await walk(dist))].sort();
const v = version();
const sw = (await readFile(path.join(src, 'sw.js'), 'utf8'))
  .replace('__VERSION__', v)
  .replace('__VENDOR_VERSION__', ortVersion)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
await writeFile(path.join(dist, 'sw.js'), sw);

const tjsVersion = tjs.version;
await writeFile(
  path.join(dist, 'build.json'),
  `${JSON.stringify({ version: v, transformers: tjsVersion, onnxruntimeWeb: ortVersion, precache: precache.length }, null, 2)}\n`,
);
console.log(`built ${v}: ${precache.length} precached files, transformers.js ${tjsVersion}, onnxruntime-web ${ortVersion}`);
