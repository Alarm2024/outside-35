import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes, daylightWindows } from '../src/lib/sun.js';

const near = (actual, expectedIso, minutes, label) => {
  const diff = Math.abs(actual - new Date(expectedIso)) / 60000;
  assert.ok(diff <= minutes, `${label}: ${actual.toISOString()} is ${diff.toFixed(1)} min from ${expectedIso}`);
};

// Royal Observatory, Greenwich. Published almanac times (UTC).
const GREENWICH = [51.4769, 0.0];

test('Greenwich, June solstice', () => {
  const t = sunTimes(new Date('2026-06-21T12:00:00Z'), ...GREENWICH);
  near(t.sunrise, '2026-06-21T03:43:00Z', 3, 'sunrise');
  near(t.sunset, '2026-06-21T20:21:00Z', 3, 'sunset');
});

test('Greenwich, December solstice', () => {
  const t = sunTimes(new Date('2026-12-21T12:00:00Z'), ...GREENWICH);
  near(t.sunrise, '2026-12-21T08:04:00Z', 3, 'sunrise');
  near(t.sunset, '2026-12-21T15:53:00Z', 3, 'sunset');
});

test('solar noon tracks longitude', () => {
  // At 90 degrees west, solar noon is about 18:00 UTC (± equation of time).
  const t = sunTimes(new Date('2026-03-20T18:00:00Z'), 0, -90);
  near(t.solarNoon, '2026-03-20T18:00:00Z', 17, 'solar noon');
  assert.ok(t.sunrise < t.solarNoon && t.solarNoon < t.sunset);
});

test('polar night and polar day are reported, not guessed', () => {
  const tromso = [69.65, 18.96];
  assert.equal(sunTimes(new Date('2026-12-21T11:00:00Z'), ...tromso).polar, 'night');
  assert.equal(sunTimes(new Date('2026-06-21T11:00:00Z'), ...tromso).polar, 'day');
});

test('rejects impossible coordinates', () => {
  assert.throws(() => sunTimes(new Date(), 95, 0), RangeError);
  assert.throws(() => sunTimes(new Date(), NaN, 0), RangeError);
});

test('daylight windows cover the next 24 h without duplicates', () => {
  const now = new Date('2026-10-07T15:00:00Z');
  const w = daylightWindows(now, ...GREENWICH);
  assert.equal(w.length, 2, 'rest of today + tomorrow');
  assert.ok(w[0].end > now && w[0].start < now, 'today is in progress');
  assert.ok(w[1].start > w[0].end, 'tomorrow comes after today');
});

test('polar night has no daylight windows', () => {
  assert.deepEqual(daylightWindows(new Date('2026-12-21T11:00:00Z'), 69.65, 18.96), []);
});
