import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModelOutput } from '../src/lib/guard.js';
import { buildPrompt, conditionWords, fallbackBring, fallbackNotice, season } from '../src/lib/plan.js';

const ok = 'BRING: water, a light jacket, comfortable shoes\nNOTICE: Look for a bird landing on the nearest tree.';

test('accepts a clean two-line answer', () => {
  const r = checkModelOutput(ok, { weatherKnown: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bring, ['water', 'a light jacket', 'comfortable shoes']);
  assert.match(r.notice, /bird/);
});

test('tolerates markdown bold and bullets', () => {
  const r = checkModelOutput('**BRING:** water, a hat\n- **NOTICE:** Watch the clouds drift.', { weatherKnown: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bring, ['water', 'a hat']);
});

test('rejects any number, even a plausible one', () => {
  const r = checkModelOutput('BRING: water, a jacket\nNOTICE: It is 18 degrees, look at the sky.', { weatherKnown: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /number/);
});

test('rejects a weather prediction when there is no weather data', () => {
  const r = checkModelOutput('BRING: water, an umbrella\nNOTICE: It will rain later, watch the clouds.', { weatherKnown: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /predicted the weather/);
});

test('allows weather words when weather data exists', () => {
  const r = checkModelOutput('BRING: water, an umbrella\nNOTICE: Clouds will move fast in the wind today.', { weatherKnown: true });
  assert.equal(r.ok, true);
});

test('rejects answers missing a line, links, or long items', () => {
  assert.equal(checkModelOutput('NOTICE: the sky', { weatherKnown: true }).ok, false);
  assert.equal(checkModelOutput('BRING: water\nNOTICE: see https://example.com now', { weatherKnown: true }).ok, false);
  const long = 'BRING: an extremely long item description that never seems to end at all\nNOTICE: the sky is wide today.';
  assert.equal(checkModelOutput(long, { weatherKnown: true }).ok, false);
  assert.equal(checkModelOutput('', { weatherKnown: true }).ok, false);
});

test('the prompt itself carries no numbers', () => {
  const words = conditionWords({ minTemp: 3, maxTemp: 9, maxPop: 40, maxUv: 1, maxWind: 25, thunder: false });
  for (const p of [
    buildPrompt({ activity: 'hike', words, seasonName: 'autumn', part: 'morning' }),
    buildPrompt({ activity: 'walk', words: null, seasonName: 'unknown', part: 'unknown' }),
  ]) {
    assert.doesNotMatch(p, /[0-9]/, p);
  }
});

test('condition words come from thresholds', () => {
  assert.deepEqual(conditionWords({ minTemp: 3, maxTemp: 9, maxPop: 40, maxUv: 1, maxWind: 25, thunder: false }), {
    temp: 'cold', rain: 'some chance of rain', sun: 'weak sun', wind: 'breezy',
  });
  assert.equal(conditionWords({ minTemp: null, maxTemp: null, maxPop: null, maxUv: null, maxWind: null, thunder: false }).temp, 'unknown');
});

test('fallback text is deterministic and admits what it does not know', () => {
  assert.ok(fallbackBring('walk', null).some((i) => /weather unknown/.test(i)));
  assert.ok(fallbackBring('hike', { temp: 'cold', rain: 'rain likely', sun: 'weak sun', wind: 'calm' }).includes('a rain jacket'));
  const d = new Date('2026-10-07T12:00:00Z');
  assert.equal(fallbackNotice(d), fallbackNotice(new Date('2026-10-07T20:00:00Z')));
  assert.doesNotMatch(fallbackNotice(d), /[0-9]/);
});

test('season flips by hemisphere and is unknown without a location', () => {
  const oct = new Date('2026-10-07T12:00:00Z');
  assert.equal(season(oct, 51.5), 'autumn');
  assert.equal(season(oct, -33.9), 'spring');
  assert.equal(season(oct, 1.3), 'tropical (no clear season)');
  assert.equal(season(oct, NaN), 'unknown');
});
