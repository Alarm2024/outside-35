// Browser smoke test of the built site (dist/) in headless Chromium.
// Checks the never-guess behaviour end to end, offline mode, and that the page
// talks to nobody except Open-Meteo (only when asked).
//
//   npm run build && npm run smoke            # SCREENSHOT=1 also writes docs/screenshot.png
//   MODEL=1 npm run smoke                     # + the real model on the CPU (344 MB download)
//   MODEL=1 MODEL_DEVICE=webgpu npm run smoke # + the real model on WebGPU (SwiftShader, no GPU needed)
//   BENCH_RUNS=full:2,shared:6 (with MODEL=1, after BENCH=1 npm run build)
//                                             # + times each plan both ways (scripts/bench-page.js)
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}/`;

const device = process.env.MODEL ? (process.env.MODEL_DEVICE === 'webgpu' ? 'webgpu' : 'wasm') : null;
// A real profile on disk, like a phone's browser. A throwaway (incognito-like)
// context has a small storage quota, too small to keep 344 MB of weights.
const profile = await mkdtemp(path.join(os.tmpdir(), 'outside35-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // A software WebGPU adapter, so the WebGPU path runs without a GPU.
  args: device === 'webgpu' ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] : [],
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-GB', timezoneId: 'Europe/London',
});
const page = context.pages()[0] || (await context.newPage());
const external = [];
// The context sees the model worker's requests too, not only the page's.
context.on('request', (r) => {
  const u = new URL(r.url());
  if (u.hostname !== 'localhost') external.push(u.hostname);
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Warnings from the page and the model worker, printed if a step fails.
const consoleLines = [];
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error') consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});

let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    if (consoleLines.length) console.log(`  browser console:\n    ${consoleLines.slice(-15).join('\n    ')}`);
    throw err;
  }
  passed += 1;
  console.log(`  ok  ${name}`);
};

// A forecast built around "now", served instead of the real Open-Meteo, so the
// test is deterministic. Rain for the next six hours, dry after.
function fixtureForecast() {
  const start = Math.floor(Date.now() / 3600000) * 3600;
  const time = Array.from({ length: 48 }, (_, i) => start + i * 3600);
  return {
    hourly: {
      time,
      temperature_2m: time.map(() => 14),
      precipitation_probability: time.map((_, i) => (i < 6 ? 90 : 5)),
      uv_index: time.map(() => 2),
      wind_speed_10m: time.map(() => 12),
      weather_code: time.map((_, i) => (i < 6 ? 63 : 1)),
    },
  };
}
let weatherCalls = 0;
await context.route('https://api.open-meteo.com/**', async (route) => {
  weatherCalls += 1;
  const u = new URL(route.request().url());
  assert.match(u.searchParams.get('latitude'), /^-?\d+(\.\d{1,2})?$/, 'latitude is rounded');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureForecast()) });
});

// ?device= pins the model to one backend, so each run tests the path it names.
await page.goto(device ? `${base}?device=${device}` : base);

await step('loads with Walk selected and everything UNKNOWN', async () => {
  assert.match(await page.title(), /Outside 35/);
  assert.equal(await page.getAttribute('[data-activity="walk"]', 'aria-checked'), 'true');
  assert.match(await page.textContent('#loc-v'), /UNKNOWN/);
  assert.match(await page.textContent('#wx-v'), /UNKNOWN/);
  assert.match(await page.textContent('#btn-model'), /Download · \d+ MB, once/);
  assert.match(await page.textContent('#foot-model'), /built-in text until you load the model/);
});

await step('no location: the time is UNKNOWN with a reason, nothing invented', async () => {
  await page.click('#btn-plan');
  await page.waitForSelector('#out:not([hidden])');
  const t = await page.textContent('#o-time');
  assert.match(t, /UNKNOWN/);
  assert.match(t, /not shared yet/);
  assert.doesNotMatch(t, /UTC/);
  assert.match(await page.textContent('#o-bring'), /weather unknown/);
  assert.match(await page.textContent('#o-source'), /not loaded/);
  assert.doesNotMatch(await page.textContent('#foot-model'), /written by/);
  assert.doesNotMatch(await page.textContent('#o-prompt'), /[0-9]/);
});

await step('typed location: a sun-only window in UTC and local time', async () => {
  await page.click('.manual summary');
  await page.fill('#loc-input', '51.4769, -0.0005');
  await page.click('#loc-form button');
  assert.match(await page.textContent('#loc-v'), /51\.48, (-)?0\.00/);
  await page.click('#btn-plan');
  const t = await page.textContent('#o-time');
  assert.match(t, /\d\d:\d\d–\d\d:\d\d UTC/);
  assert.match(t, /Europe\/London/);
  const why = await page.textContent('#o-why');
  assert.match(why, /Sun: rises \d\d:\d\d UTC/);
  assert.match(why, /Weather: UNKNOWN/);
});

if (process.env.SCREENSHOT) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(root, 'docs', 'screenshot.png'), fullPage: true });
  console.log('  wrote docs/screenshot.png');
}

await step('weather: the window avoids the rainy hours and shows its numbers', async () => {
  await page.click('#btn-wx');
  await page.waitForFunction(() => /Forecast from/.test(document.querySelector('#wx-v').textContent));
  await page.click('#btn-plan');
  const why = await page.textContent('#o-why');
  assert.match(why, /rain chance up to 5%/, why);
  assert.match(why, /Open-Meteo/);
  assert.equal(weatherCalls, 1);
});

await step('works offline after the first visit (service worker)', async () => {
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(async () => {
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  });
  await context.setOffline(true);
  await page.reload();
  assert.match(await page.title(), /Outside 35/);
  assert.match(await page.textContent('#loc-v'), /51\.48/);
  await page.click('#btn-plan');
  assert.match(await page.textContent('#o-time'), /UTC/);
  await context.setOffline(false);
});

await step('the model button reloads a first visit once: isolated, so the model gets every CPU thread', async () => {
  // A new profile: its first page is served before the service worker runs,
  // so it is not cross-origin isolated until that one reload.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'outside35-first-'));
  const fresh = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM_PATH || undefined });
  const hosts = [];
  fresh.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost') hosts.push(u.hostname);
  });
  try {
    const p = fresh.pages()[0] || (await fresh.newPage());
    await p.goto(base);
    await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    assert.equal(await p.evaluate(() => self.crossOriginIsolated), false);
    // The asyncify build on the CPU lacks GatherBlockQuantized: the exact failure
    // seen after a full 344 MB download before the check existed. So this also
    // shows the check runs after the reload, before any download.
    await p.evaluate(() => history.replaceState(null, '', '?device=wasm&build=asyncify'));
    await Promise.all([p.waitForNavigation(), p.click('#btn-model')]);
    assert.equal(await p.evaluate(() => self.crossOriginIsolated), true, 'the service worker made the page cross-origin isolated');
    await p.waitForFunction(() => /cannot run it|ready|could not load/.test(document.querySelector('#model-v').textContent), null, { timeout: 60000 });
    const mv = await p.textContent('#model-v');
    assert.match(mv, /cannot run it/, mv);
    assert.match(mv, /GatherBlockQuantized/, mv);
    assert.match(mv, /Nothing was downloaded/, mv);
    assert.doesNotMatch(await p.textContent('#foot-model'), /chosen by/);
    assert.deepEqual(hosts, [], `external hosts: ${hosts.join(', ')}`);
  } finally {
    await fresh.close();
    await rm(dir, { recursive: true, force: true });
  }
});

await step('talks to nobody but Open-Meteo, and only when asked', async () => {
  const hosts = [...new Set(external)];
  assert.deepEqual(hosts, ['api.open-meteo.com'], `external hosts: ${hosts.join(', ')}`);
});

await step('no page errors', async () => {
  assert.deepEqual(errors, []);
});

if (process.env.MODEL) {
  // The real model, in this browser: about 344 MB from the Hugging Face Hub.
  const where = device === 'webgpu' ? /WebGPU/ : /CPU \(WebAssembly, /;
  await page.goto(`${base}?device=${device}`);
  const summary = [];
  const waitText = (sel, re, ms) => page.waitForFunction(
    ([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout: ms },
  );

  await step('real model: downloads and loads in the browser', async () => {
    const t = Date.now();
    await page.click('#btn-model');
    await waitText('#model-v', /ready|could not load|cannot run it/, 20 * 60000);
    const mv = await page.textContent('#model-v');
    const est = await page.evaluate(() => navigator.storage.estimate());
    const line = `Browser storage: ${(est.usage / 1e6).toFixed(0)} MB used of ${(est.quota / 1e6).toFixed(0)} MB allowed`;
    console.log(`  ${line}`);
    summary.push(line);
    assert.match(mv, /ready/, mv);
    assert.match(mv, where, mv);
    assert.doesNotMatch(mv, /not saved/, mv);
    // The page came through the service worker, so it is isolated and the CPU
    // path gets more than one thread.
    assert.equal(await page.evaluate(() => self.crossOriginIsolated), true);
    if (device === 'wasm') assert.match(mv, /WebAssembly, [2-9]\d* threads/, mv);
    assert.match(await page.textContent('#foot-model'), /chosen by Gemma/);
    summary.push(`Loaded in the browser in ${((Date.now() - t) / 1000).toFixed(0)} s: ${mv}`);
  });

  const writePlan = async (label) => {
    // Every text the source line shows, from the click to the end.
    await page.evaluate(() => {
      window.sourceLog = [];
      new MutationObserver(() => window.sourceLog.push(document.querySelector('#o-source').textContent))
        .observe(document.querySelector('#o-source'), { childList: true, characterData: true, subtree: true });
    });
    const t = Date.now();
    await page.click('#btn-plan');
    // The built-in choice shows at once, while the model ranks.
    await waitText('#o-source', /ranking our lists|ranked our lists|failed/, 5000);
    const firstShown = (Date.now() - t) / 1000;
    assert.ok((await page.locator('#o-bring li').count()) > 0, 'the built-in Bring list shows while the model ranks');
    await waitText('#o-source', /ranked our lists|failed/, 10 * 60000);
    const source = await page.textContent('#o-source');
    const raw = await page.textContent('#o-raw');
    const log = await page.evaluate(() => window.sourceLog);
    const steps = log.filter((x) => /ranking our lists.*\d+\/\d+/.test(x));
    // One <li> per item: the code's must-bring items, then the model's top three.
    const items = await page.locator('#o-bring li').allTextContents();
    const top3 = raw.split('Notice:')[0].split('\n').slice(1, 4).map((x) => x.replace(/^[+-]\d+\.\d+\s+/, '').trim());
    summary.push(`${label}: ${source}`, `  ranking:\n${raw.replace(/^/gm, '    ')}`,
      `  bring (${items.length} items): ${items.join(' · ')}`, `  notice: ${await page.textContent('#o-notice')}`,
      `  built-in choice shown after ${firstShown.toFixed(1)} s; progress shown ${steps.length} times, last: ${steps.length ? steps.at(-1).replace(/^.*device: /, '') : 'none'}`);
    assert.match(source, /ranked our lists/, source);
    assert.match(raw, /Bring:[\s\S]*Notice:/, 'the ranking is shown');
    assert.ok(steps.length > 0, 'progress is shown while ranking');
    assert.deepEqual(items.slice(-3), top3, 'Bring ends with the model\'s top three, each its own item');
  };

  await step('real model: ranks the lists and chooses Bring and Notice', async () => {
    await writePlan('Online');
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(root, 'docs', `screenshot-model-${device}.png`), fullPage: true });
  });

  await step('real model: loads again with no signal, from the browser cache', async () => {
    await context.setOffline(true);
    await page.reload();
    await waitText('#model-v', /saved on this device/, 30000);
    await page.click('#btn-model');
    await waitText('#model-v', /ready|could not load|cannot run it/, 5 * 60000);
    const mv = await page.textContent('#model-v');
    assert.match(mv, /ready/, mv);
    await writePlan('Offline');
    await context.setOffline(false);
  });

  if (process.env.BENCH_RUNS) {
    await step('real model: each plan timed, the old way and the app\'s way', async () => {
      // The app page's worker holds a copy of the model; free it first.
      await page.goto('about:blank');
      const bench = await context.newPage();
      await bench.goto(`${base}bench.html?device=${device}&runs=${encodeURIComponent(process.env.BENCH_RUNS)}`);
      await bench.waitForFunction(() => window.bench && window.bench.done, null, { timeout: 40 * 60000, polling: 1000 });
      const result = await bench.evaluate(() => window.bench);
      await bench.close();
      summary.push('', 'Each plan timed in this browser (a plan that has to work out its no-plan scores pays for those too):');
      for (const r of result.rows || []) {
        summary.push(`  ${r.secs.toFixed(1).padStart(6)} s  ${r.label} [${r.threads} thread${r.threads === 1 ? '' : 's'}]  ·  ${r.plan}  →  ${r.ranked.bring.slice(0, 3).map((x) => x.c).join(', ')} | ${r.ranked.notice[0].c}`);
      }
      assert.equal(result.error, undefined, result.error);
      // Every pair of runs that ranked the same plan: how far apart are the scores?
      const score = (r, list, c) => r.ranked[list].find((y) => y.c === c).score;
      let maxDiff = 0;
      const rows = result.rows;
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          if (rows[i].plan !== rows[j].plan) continue;
          for (const list of ['bring', 'notice']) {
            for (const x of rows[i].ranked[list]) maxDiff = Math.max(maxDiff, Math.abs(x.score - score(rows[j], list, x.c)));
          }
        }
      }
      summary.push(`  largest score difference between runs of the same plan: ${maxDiff.toExponential(1)}`);
      // Every score for one plan both devices rank, so CPU and WebGPU can be compared.
      const scores = (r) => ['bring', 'notice'].map((l) => r.ranked[l].map((x) => `${x.score.toFixed(3)} ${x.c}`).join('; ')).join(' || ');
      const shown = device === 'webgpu' ? rows : rows.filter((r) => r.plan === 'a short walk').slice(0, 1);
      for (const r of shown) summary.push(`  scores, ${r.plan}, ${r.label}: ${scores(r)}`);
      // On WebGPU the app keeps one run per answer; the prompt-once run there is
      // a study of why they differ, not something the app relies on.
      if (device !== 'webgpu') assert.ok(maxDiff <= 1e-3, `runs of the same plan disagree by ${maxDiff}`);
    });
  }

  const title = device === 'webgpu' ? 'WebGPU (SwiftShader, a software GPU: slow, but the same code path)' : 'the CPU (WebAssembly)';
  const text = ['', `## Gemma in headless Chromium, on ${title}`, '', '```', ...summary, '```', ''].join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  }
}

await context.close();
await rm(profile, { recursive: true, force: true });
server.close();
console.log(`\nsmoke: ${passed} checks passed`);
