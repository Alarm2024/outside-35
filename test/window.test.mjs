import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindow } from '../src/lib/window.js';
import { daylightWindows } from '../src/lib/sun.js';
import { parseForecast } from '../src/lib/weather.js';

const now = new Date('2026-10-07T07:00:00Z');
const GREENWICH = [51.4769, 0.0];
const daylight = { known: true, windows: daylightWindows(now, ...GREENWICH) };

function forecast(overrides = () => ({})) {
  const start = Date.UTC(2026, 9, 7, 0) / 1000;
  const time = Array.from({ length: 48 }, (_, i) => start + i * 3600);
  const hourly = { time, temperature_2m: [], precipitation_probability: [], uv_index: [], wind_speed_10m: [], weather_code: [] };
  time.forEach((t, i) => {
    const o = { temp: 15, pop: 10, uv: 2, wind: 10, code: 1, ...overrides(new Date(t * 1000), i) };
    hourly.temperature_2m.push(o.temp);
    hourly.precipitation_probability.push(o.pop);
    hourly.uv_index.push(o.uv);
    hourly.wind_speed_10m.push(o.wind);
    hourly.weather_code.push(o.code);
  });
  return parseForecast({ hourly }, now);
}

test('no location: the window is UNKNOWN with the reason', () => {
  const r = pickWindow({ now, activity: 'walk', daylight: { known: false, reason: 'no location shared' }, weather: { known: false, reason: 'x' } });
  assert.equal(r.status, 'UNKNOWN');
  assert.match(r.reason, /no location shared/);
});

test('no weather: earliest daylight slot, labelled as sun-only', () => {
  const r = pickWindow({ now, activity: 'walk', daylight, weather: { known: false, reason: 'not fetched yet' } });
  assert.equal(r.status, 'OK');
  assert.equal(r.basis, 'sun');
  assert.ok(r.start >= daylight.windows[0].start, 'starts after sunrise');
  assert.equal(r.end - r.start, 45 * 60000);
  assert.equal(r.weatherReason, 'not fetched yet');
});

test('with weather: avoids the rainy hours', () => {
  const f = forecast((t) => ({ pop: t.getUTCHours() >= 6 && t.getUTCHours() < 13 ? 90 : 5 }));
  const r = pickWindow({ now, activity: 'walk', daylight, weather: { known: true, forecast: f } });
  assert.equal(r.basis, 'sun+weather');
  assert.ok(r.start.getUTCHours() >= 13, `picked ${r.start.toISOString()}`);
  assert.equal(r.facts.maxPop, 5);
  assert.deepEqual(r.warnings, []);
});

test('thunder anywhere it picks is a warning, not hidden', () => {
  const f = forecast(() => ({ code: 95, pop: 80 }));
  const r = pickWindow({ now, activity: 'walk', daylight, weather: { known: true, forecast: f } });
  assert.ok(r.warnings.some((w) => /Thunderstorm/.test(w)));
});

test('missing weather fields are listed as unknown, not filled in', () => {
  const f = forecast(() => ({ uv: null }));
  const r = pickWindow({ now, activity: 'garden', daylight, weather: { known: true, forecast: f } });
  assert.equal(r.facts.maxUv, null);
  assert.ok(r.facts.unknown.includes('uv'));
});

test('a hike needs three daylight hours before sunset', () => {
  const late = new Date('2026-10-07T15:30:00Z'); // sunset in Greenwich is about 17:20 UTC
  const d = { known: true, windows: daylightWindows(late, ...GREENWICH) };
  const r = pickWindow({ now: late, activity: 'hike', daylight: d, weather: { known: false, reason: 'n/a' } });
  assert.equal(r.status, 'OK');
  assert.equal(r.start.getUTCDate(), 8, 'moves to tomorrow');
});

test('polar night: says so', () => {
  const r = pickWindow({ now, activity: 'walk', daylight: { known: true, windows: [] }, weather: { known: false, reason: 'n/a' } });
  assert.equal(r.status, 'NO_DAYLIGHT');
});
