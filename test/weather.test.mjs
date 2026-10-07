import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastUrl, parseForecast, weatherState, fetchForecast, forecastToJSON, forecastFromJSON } from '../src/lib/weather.js';

test('only rounded coordinates leave the device', () => {
  const u = new URL(forecastUrl(51.476912, -0.000531));
  assert.equal(u.hostname, 'api.open-meteo.com');
  assert.equal(u.searchParams.get('latitude'), '51.48');
  assert.equal(u.searchParams.get('longitude'), '0');
  assert.equal(u.searchParams.get('timezone'), 'GMT');
  assert.ok(!u.search.includes('apikey'), 'no key');
});

test('missing columns become null, never zero', () => {
  const f = parseForecast({ hourly: { time: [1, 2], temperature_2m: [10, null] } }, 0);
  assert.equal(f.hours[0].temp, 10);
  assert.equal(f.hours[1].temp, null);
  assert.equal(f.hours[0].pop, null);
  assert.equal(f.hours[0].uv, null);
});

test('a broken response is an error, not an empty forecast', () => {
  assert.throws(() => parseForecast({}, 0), /no hourly data/);
});

test('stale or missing forecasts are UNKNOWN with a reason', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  assert.match(weatherState(null, now).reason, /not fetched/);
  assert.match(weatherState(null, now, { online: false }).reason, /no signal/);
  const old = { fetchedAt: new Date('2026-10-07T08:00:00Z'), hours: [] };
  const s = weatherState(old, now);
  assert.equal(s.known, false);
  assert.match(s.reason, /4 h old/);
  const fresh = { fetchedAt: new Date('2026-10-07T11:00:00Z'), hours: [] };
  assert.equal(weatherState(fresh, now).known, true);
});

test('HTTP errors surface', async () => {
  const fake = async () => ({ ok: false, status: 429 });
  await assert.rejects(fetchForecast(1, 2, fake), /HTTP 429/);
});

test('round-trips through localStorage JSON', () => {
  const f = parseForecast({ hourly: { time: [1700000000], temperature_2m: [7] } }, 1700000000000);
  const back = forecastFromJSON(JSON.parse(JSON.stringify(forecastToJSON(f))));
  assert.equal(back.hours[0].t.valueOf(), 1700000000000);
  assert.equal(back.fetchedAt.valueOf(), 1700000000000);
});
