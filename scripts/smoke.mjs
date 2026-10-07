// Browser smoke test of the built site (dist/) in headless Chromium.
// Checks the never-guess behaviour end to end, offline mode, and that the page
// talks to nobody except Open-Meteo (only when asked).
//
//   npm run build && npm run smoke            # SCREENSHOT=1 also writes docs/screenshot.png
//   MODEL=1 npm run smoke                     # + the real model on the CPU (344 MB download)
//   MODEL=1 MODEL_DEVICE=webgpu npm run smoke # + the real model on WebGPU (SwiftShader, no GPU needed)
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
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
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // A software WebGPU adapter, so the WebGPU path runs without a GPU.
  args: device === 'webgpu' ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] : [],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-GB', timezoneId: 'Europe/London' });
const page = await context.newPage();
const external = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.hostname !== 'localhost') external.push(u.hostname);
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let passed = 0;
const step = async (name, fn) => {
  await fn();
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

await step('talks to nobody but Open-Meteo, and only when asked', async () => {
  const hosts = [...new Set(external)];
  assert.deepEqual(hosts, ['api.open-meteo.com'], `external hosts: ${hosts.join(', ')}`);
});

await step('no page errors', async () => {
  assert.deepEqual(errors, []);
});

if (process.env.MODEL) {
  // The real model, in this browser: about 344 MB from the Hugging Face Hub.
  const where = device === 'webgpu' ? /WebGPU/ : /CPU \(WebAssembly\)/;
  const summary = [];
  const waitText = (sel, re, ms) => page.waitForFunction(
    ([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout: ms },
  );

  await step('real model: downloads and loads in the browser', async () => {
    const t = Date.now();
    await page.click('#btn-model');
    await waitText('#model-v', /ready|could not load/, 20 * 60000);
    const mv = await page.textContent('#model-v');
    assert.match(mv, /ready/, mv);
    assert.match(mv, where, mv);
    summary.push(`Loaded in the browser in ${((Date.now() - t) / 1000).toFixed(0)} s: ${mv}`);
  });

  const writePlan = async (label) => {
    await page.click('#btn-plan');
    await waitText('#o-source', /picked what to bring|was not used|failed/, 10 * 60000);
    const source = await page.textContent('#o-source');
    const raw = await page.textContent('#o-raw');
    summary.push(`${label}: ${source}`, `  raw answer: ${JSON.stringify(raw)}`,
      `  bring: ${await page.textContent('#o-bring')}`, `  notice: ${await page.textContent('#o-notice')}`);
    assert.match(source, /picked what to bring|was not used/, source);
    assert.ok(raw.trim().length > 0, 'the model answered');
  };

  await step('real model: writes a plan, which is used or honestly discarded', async () => {
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
    await waitText('#model-v', /ready|could not load/, 5 * 60000);
    const mv = await page.textContent('#model-v');
    assert.match(mv, /ready/, mv);
    await writePlan('Offline');
    await context.setOffline(false);
  });

  const title = device === 'webgpu' ? 'WebGPU (SwiftShader, a software GPU: slow, but the same code path)' : 'the CPU (WebAssembly)';
  const text = ['', `## Gemma in headless Chromium, on ${title}`, '', '```', ...summary, '```', ''].join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  }
}

await browser.close();
server.close();
console.log(`\nsmoke: ${passed} checks passed`);
