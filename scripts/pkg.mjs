// Where an npm package lives, for packages that do not export package.json:
// walk up from their entry file.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function pkgDir(req, name) {
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

/** ONNX Runtime Web, the exact version Transformers.js depends on. */
export async function ortPackage(fromUrl) {
  const tjs = await pkgDir(createRequire(fromUrl), '@huggingface/transformers');
  const ort = await pkgDir(createRequire(path.join(tjs.dir, 'package.json')), 'onnxruntime-web');
  return { tjs, ort };
}
