// Build the static site into dist/: bundle the app (the model code is a
// separate chunk, loaded only on demand), copy ONNX Runtime's WASM so nothing
// comes from a CDN, and stamp the service worker with a version and file list.
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const require = createRequire(import.meta.url);

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
  entryPoints: [path.join(src, 'app.js')],
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
await cp(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE.txt'));
await writeFile(path.join(dist, '.nojekyll'), '');

// Packages that do not export package.json: walk up from their entry file.
async function pkgDir(req, name) {
  let dir = path.dirname(req.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return { dir, version: pkg.version };
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`cannot find package.json for ${name}`);
    dir = up;
  }
}

// ONNX Runtime Web, the exact version Transformers.js depends on.
const tjs = await pkgDir(require, '@huggingface/transformers');
const ort = await pkgDir(createRequire(path.join(tjs.dir, 'package.json')), 'onnxruntime-web');
const ortVersion = ort.version;
const ortDist = path.join(ort.dir, 'dist');
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
