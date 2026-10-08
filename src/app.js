import { ACTIVITIES, pickWindow } from './lib/window.js';
import { daylightWindows, sunTimes } from './lib/sun.js';
import { fetchForecast, weatherState, forecastToJSON, forecastFromJSON, round2, WEATHER_SOURCE } from './lib/weather.js';
import { conditionWords, season, timeOfDay, bringOptions, requiredLabel, fallbackBring, noticeOptions, fallbackNotice } from './lib/plan.js';
import { rankingQuestions } from './lib/rank.js';
import { rangeLabel, hhmmUTC, localTime, deviceZone } from './lib/format.js';
import { MODEL } from './lib/model-info.js';

const $ = (id) => document.getElementById(id);

// localStorage can be missing or full; the app must still work without it.
const store = {
  get(k) {
    try { return JSON.parse(localStorage.getItem(`o35:${k}`)); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(`o35:${k}`, JSON.stringify(v)); } catch { /* not saved */ }
  },
};

function loadForecast() {
  try {
    const f = store.get('forecast');
    return f ? forecastFromJSON(f) : null;
  } catch {
    return null;
  }
}

const state = {
  activity: ACTIVITIES[store.get('activity')] ? store.get('activity') : 'walk',
  location: store.get('location'),
  locationReason: 'not shared yet (tap Use my location, or type it)',
  forecast: loadForecast(),
  forecastError: null,
  model: { status: 'idle', device: null, error: null, progress: 0, stage: null, fellBack: false },
};

let modelModule = null;

/** Build a node with text only. Model output never goes through innerHTML. */
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function unknown(reason) {
  const frag = document.createDocumentFragment();
  frag.append(el('span', 'UNKNOWN', 'unk'), document.createTextNode(` ${reason}`));
  return frag;
}

// ── Rendering ────────────────────────────────────────────────────────────
function renderActivity() {
  for (const b of document.querySelectorAll('[data-activity]')) {
    b.setAttribute('aria-checked', String(b.dataset.activity === state.activity));
  }
}

function renderLocation() {
  const v = $('loc-v');
  if (state.location) {
    v.replaceChildren(`${state.location.lat.toFixed(2)}, ${state.location.lon.toFixed(2)} (saved on this device)`);
  } else {
    v.replaceChildren(unknown(state.locationReason));
  }
}

function currentWeather(now = new Date()) {
  if (!state.location) return { known: false, reason: 'no location yet, so no weather' };
  return weatherState(state.forecast, now, { online: navigator.onLine, reasonIfMissing: state.forecastError });
}

function renderWeather() {
  const ws = currentWeather();
  const v = $('wx-v');
  if (ws.known) {
    const at = ws.forecast.fetchedAt;
    v.replaceChildren(el('span', `Forecast from ${hhmmUTC(at)} UTC`, 'ok'), ` (${WEATHER_SOURCE})`);
  } else {
    v.replaceChildren(unknown(ws.reason));
  }
  $('btn-wx').disabled = !state.location;
}

function renderModel() {
  const m = state.model;
  const v = $('model-v');
  const btn = $('btn-model');
  const bar = $('model-progress');
  bar.hidden = m.status !== 'loading';
  btn.hidden = m.status === 'ready' || m.status === 'loading';
  if (m.status === 'idle') {
    v.replaceChildren(`${MODEL.name}: not on this device yet`);
    btn.textContent = `Download · ${MODEL.downloadMB} MB, once`;
  } else if (m.status === 'cached') {
    v.replaceChildren(`${MODEL.name}: saved on this device`);
    btn.textContent = 'Load model';
  } else if (m.status === 'loading' && m.stage === 'checking') {
    v.replaceChildren(`${MODEL.name}: checking this browser can run it (nothing downloaded yet)…`);
    bar.removeAttribute('value');
  } else if (m.status === 'loading') {
    v.replaceChildren(`${MODEL.name}: loading… ${Math.round(m.progress)}%`);
    bar.value = m.progress;
  } else if (m.status === 'ready') {
    const where = m.device === 'webgpu' ? 'your GPU (WebGPU)' : 'your CPU (WebAssembly)';
    v.replaceChildren(el('span', `${MODEL.name}: ready`, 'ok'), ` · running on ${where}`);
    if (m.fellBack) v.append(' (WebGPU did not work on this device, so it uses the CPU)');
    if (m.saved === false) v.append(' · not saved for use with no signal: this browser did not allow the storage, so it will download again next time');
  } else if (m.status === 'unsupported') {
    v.replaceChildren(`${MODEL.name}: this browser cannot run it (${m.error}). Nothing was downloaded. Plans still work with built-in text.`);
    btn.textContent = 'Try again';
  } else if (m.status === 'error') {
    v.replaceChildren(`${MODEL.name}: could not load (${m.error}). Plans still work with built-in text.`);
    btn.textContent = 'Try again';
  }
  // Only claim the model wrote anything when it is actually loaded.
  $('foot-model').textContent = m.status === 'ready'
    ? `Bring picks and Notice are chosen by ${MODEL.name}, an open-weight model, on your device, from lines we wrote and your data allows. Times and weather come from code and data, never from the model.`
    : 'Bring and Notice are built-in text until you load the model. Times and weather come from code and data, never from a model.';
}

function renderAll() {
  renderActivity();
  renderLocation();
  renderWeather();
  renderModel();
}

// ── Actions ──────────────────────────────────────────────────────────────
function setLocation(lat, lon) {
  // Two decimals (about 1 km) is plenty for sun times and weather.
  state.location = { lat: round2(lat), lon: round2(lon) };
  store.set('location', state.location);
  // A forecast for somewhere else is not a forecast for here.
  state.forecast = null;
  state.forecastError = null;
  store.set('forecast', null);
  renderAll();
}

function useMyLocation() {
  if (!('geolocation' in navigator)) {
    state.locationReason = 'this browser has no location support (type it instead)';
    renderLocation();
    return;
  }
  $('btn-loc').disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('btn-loc').disabled = false;
      setLocation(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      $('btn-loc').disabled = false;
      state.locationReason = {
        1: 'you did not allow location (you can type it instead)',
        2: 'the device could not find a position',
        3: 'finding a position took too long',
      }[err.code] || 'the device could not find a position';
      renderLocation();
      renderWeather();
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
  );
}

function typedLocation(e) {
  e.preventDefault();
  const msg = $('loc-form-msg');
  const parts = $('loc-input').value.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x)) || Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) {
    msg.textContent = 'Use "latitude, longitude", for example 51.48, -0.01.';
    return;
  }
  msg.textContent = '';
  setLocation(parts[0], parts[1]);
  $('loc-input').closest('details').open = false;
}

async function checkWeather() {
  if (!state.location) return;
  if (!navigator.onLine) {
    state.forecastError = 'no signal right now';
    renderWeather();
    return;
  }
  const btn = $('btn-wx');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    state.forecast = await fetchForecast(state.location.lat, state.location.lon);
    state.forecastError = null;
    store.set('forecast', forecastToJSON(state.forecast));
  } catch (err) {
    state.forecastError = `Open-Meteo did not answer (${err.message})`;
  } finally {
    btn.textContent = 'Check weather';
    renderWeather();
  }
}

async function loadModel() {
  state.model = { ...state.model, status: 'loading', progress: 0, error: null, stage: null };
  renderModel();
  try {
    modelModule = modelModule || (await import('./model.js'));
    const { device, fellBack } = await modelModule.loadModel(
      (p) => {
        if (typeof p.progress === 'number') {
          state.model.progress = p.progress;
          renderModel();
        }
      },
      (stage) => {
        state.model.stage = stage;
        renderModel();
      },
    );
    // Say so if the browser would not keep the weights: then it is not offline-ready.
    const saved = await modelIsCached();
    state.model = { status: 'ready', device, fellBack, saved, error: null, progress: 100, stage: null };
  } catch (err) {
    console.error(err);
    const message = err && err.message ? err.message.slice(0, 160) : 'unknown error';
    // Failing the operator check means this browser's runtime cannot run Gemma;
    // that is found out before any download, and said plainly.
    const unsupported = state.model.stage === 'checking';
    const reason = unsupported || navigator.onLine ? message : 'no signal, and it is not saved on this device yet';
    state.model = { status: unsupported ? 'unsupported' : 'error', device: null, error: reason, progress: 0, stage: null, fellBack: false };
  }
  renderModel();
}

async function modelIsCached() {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open('transformers-cache');
    const url = `https://huggingface.co/${MODEL.id}/resolve/main/onnx/${MODEL.file}`;
    return Boolean(await cache.match(url));
  } catch {
    return false;
  }
}

// ── The plan ─────────────────────────────────────────────────────────────
function describeFacts(f) {
  const part = (label, v, unit) => (v === null ? `${label} UNKNOWN (missing from the forecast)` : `${label} up to ${v}${unit}`);
  const temp = f.minTemp === null ? 'temperature UNKNOWN (missing from the forecast)' : `${f.minTemp} to ${f.maxTemp} °C`;
  return [
    temp,
    part('rain chance', f.maxPop, '%'),
    part('UV', f.maxUv, ''),
    part('wind', f.maxWind, ' km/h'),
  ].join(', ');
}

function renderTime(win, now, sun) {
  const time = $('o-time');
  const why = $('o-why');
  const warn = $('o-warn');
  warn.replaceChildren();
  why.replaceChildren();
  if (win.status !== 'OK') {
    time.replaceChildren(win.status === 'UNKNOWN' ? unknown(win.reason) : `${win.reason}.`);
    if (win.status === 'UNKNOWN') why.textContent = 'Share or type a location so sunrise and sunset can be worked out on this device.';
    return;
  }
  const zone = deviceZone();
  const r = rangeLabel(win.start, win.end, now);
  time.replaceChildren(el('strong', r.utc), el('br'), `${r.local} (this device)`);
  const lines = [`Why: ${win.why}.`];
  if (sun && sun.sunrise) {
    lines.push(`Sun: rises ${hhmmUTC(sun.sunrise)} UTC (${localTime(sun.sunrise)} ${zone}), sets ${hhmmUTC(sun.sunset)} UTC (${localTime(sun.sunset)} ${zone}), worked out on this device.`);
  }
  why.append(...lines.map((l) => el('span', `${l} `)));
  if (win.basis === 'sun+weather') {
    why.append(el('span', `Forecast for that window: ${describeFacts(win.facts)}. Source: ${WEATHER_SOURCE}.`));
  } else {
    why.append(el('span', 'Weather: '), unknown(win.weatherReason));
  }
  for (const w of win.warnings) warn.append(el('li', w));
}

async function makePlan() {
  const btn = $('btn-plan');
  btn.disabled = true;
  const now = new Date();
  const loc = state.location;
  const daylight = loc
    ? { known: true, windows: daylightWindows(now, loc.lat, loc.lon) }
    : { known: false, reason: state.locationReason };
  const weather = currentWeather(now);
  const win = pickWindow({ now, activity: state.activity, daylight, weather });
  const sun = loc ? sunTimes(win.status === 'OK' ? win.start : now, loc.lat, loc.lon) : null;

  const words = win.status === 'OK' && win.basis === 'sun+weather' ? conditionWords(win.facts) : null;
  const seasonName = loc ? season(now, loc.lat) : 'unknown';
  const part = win.status === 'OK' && sun ? timeOfDay(win.start, sun.solarNoon) : 'unknown';
  const plan = { activity: state.activity, words, seasonName, part };
  const options = bringOptions(state.activity, words);
  const notices = noticeOptions(plan);
  const q = rankingQuestions(plan);

  $('out').hidden = false;
  renderTime(win, now, sun && !sun.polar ? sun : null);
  $('o-prompt').textContent = [
    q.bring.question, ...options.optional.map((c) => `  · ${c}`), '',
    q.notice.question, ...notices.map((c) => `  · ${c}`),
  ].join('\n');
  $('o-raw-wrap').hidden = true;

  // The built-in choice shows at once; the model's choice replaces it when ready.
  const show = (bring, notice, source) => {
    $('o-bring').replaceChildren(...bring.map((b) => el('li', b)));
    $('o-notice').textContent = notice;
    $('o-source').textContent = source;
  };
  const builtIn = [fallbackBring(state.activity, words), fallbackNotice(now, notices)];
  show(...builtIn, `${MODEL.name} is not loaded, so this is the built-in choice. Load the model to have it choose on your device.`);
  $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (state.model.status === 'ready') {
    const ranking = (done, total) => `Built-in choice for now. ${MODEL.name} is ranking our lists for this plan on your device${total ? `: ${done}/${total}` : ''}…`;
    $('o-source').textContent = ranking(0, 0);
    try {
      const t0 = performance.now();
      const ranked = await modelModule.rankPlan(plan, options.optional, notices, ({ done, total }) => {
        $('o-source').textContent = ranking(done, total);
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      show(
        [...options.required.map(requiredLabel), ...ranked.bring.slice(0, 3).map((r) => r.c)],
        ranked.notice[0].c,
        `${MODEL.name} ranked our lists for this plan on your device in ${secs} s and chose the three things to bring and the thing to notice. It can only choose lines we wrote and your data allows, so it cannot invent a fact.`,
      );
      const line = (r) => `${r.score >= 0 ? '+' : ''}${r.score.toFixed(2)}  ${r.c}`;
      $('o-raw').textContent = ['Bring:', ...ranked.bring.map(line), '', 'Notice:', ...ranked.notice.map(line)].join('\n');
      $('o-raw-wrap').hidden = false;
    } catch (err) {
      show(...builtIn, `${MODEL.name} failed (${err.message}). Showing the built-in choice instead.`);
    }
  }
  btn.disabled = false;
}

// ── Wire up ──────────────────────────────────────────────────────────────
for (const b of document.querySelectorAll('[data-activity]')) {
  b.addEventListener('click', () => {
    state.activity = b.dataset.activity;
    store.set('activity', state.activity);
    renderActivity();
  });
}
$('btn-loc').addEventListener('click', useMyLocation);
$('loc-form').addEventListener('submit', typedLocation);
$('btn-wx').addEventListener('click', checkWeather);
$('btn-model').addEventListener('click', loadModel);
$('btn-plan').addEventListener('click', makePlan);
window.addEventListener('online', renderWeather);
window.addEventListener('offline', renderWeather);

renderAll();
modelIsCached().then((cached) => {
  if (cached && state.model.status === 'idle') {
    state.model.status = 'cached';
    renderModel();
  }
});

const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && secure) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker not registered', err));
}
