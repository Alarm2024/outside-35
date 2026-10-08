import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bringOptions, conditionWords, fallbackBring, fallbackNotice, noticeOptions, normItem, season } from '../src/lib/plan.js';

const F = (minTemp, maxTemp, maxPop, maxUv, maxWind, thunder = false) => ({ minTemp, maxTemp, maxPop, maxUv, maxWind, thunder });

test('condition words come from thresholds', () => {
  assert.deepEqual(conditionWords(F(3, 9, 40, 1, 25)), { temp: 'cold', rain: 'some chance of rain', sun: 'weak sun', wind: 'breezy' });
  assert.equal(conditionWords({ minTemp: null, maxTemp: null, maxPop: null, maxUv: null, maxWind: null, thunder: false }).temp, 'unknown');
});

test('the data decides what you must bring; the model only ranks the rest', () => {
  const g = bringOptions('garden', conditionWords(F(22, 29, 0, 8, 8)));
  assert.deepEqual(g.required.map((r) => r.item), ['a hat', 'sunscreen', 'extra water']);
  assert.ok(!g.optional.includes('a hat'), 'a required item is not offered again');
  assert.deepEqual(bringOptions('walk', null).required, [{ item: 'a light layer', why: 'weather unknown' }]);
  assert.equal(normItem('The Notebook.'), 'notebook');
});

test('Notice lines that need weather only appear with weather data', () => {
  const none = noticeOptions({ activity: 'walk', words: null, seasonName: 'unknown', part: 'unknown' });
  assert.ok(none.length >= 4);
  assert.ok(none.every((n) => !/rain|wind|frost|breath|shade|leaves changing|buds|bare branches|bees/i.test(n)), none.join(' / '));
  const wet = noticeOptions({ activity: 'hike', words: conditionWords(F(3, 8, 70, 1, 35)), seasonName: 'winter', part: 'morning' });
  for (const want of [/rain darkens/, /wind in the tallest/, /breath/, /bare branches/, /morning songs/]) assert.ok(wet.some((n) => want.test(n)), want.source);
  assert.ok(!wet.some((n) => /soil/.test(n)), 'garden lines only in the garden');
  const dry = noticeOptions({ activity: 'walk', words: conditionWords(F(14, 17, 10, 2, 12)), seasonName: 'autumn', part: 'afternoon' });
  assert.ok(!dry.some((n) => /rain|wind|breath/.test(n)), 'a dry, calm, cool day has no rain, wind or cold lines');
  for (const n of [...none, ...wet, ...dry]) assert.doesNotMatch(n, /[0-9]/);
});

test('at most six Notice lines go to the model, the ones tied to this plan first', () => {
  const wet = noticeOptions({ activity: 'hike', words: conditionWords(F(3, 8, 70, 1, 35)), seasonName: 'winter', part: 'morning' });
  assert.equal(wet.length, 6);
  assert.ok(!wet.includes('Listen for the quietest sound around you.'), 'a line for any plan gives way to one about this plan');
  const dry = noticeOptions({ activity: 'walk', words: conditionWords(F(14, 17, 10, 2, 12)), seasonName: 'autumn', part: 'afternoon' });
  assert.deepEqual(dry.slice(0, 3), ['Look for the first leaves changing colour.', 'Watch the light change as the sun gets lower.', 'Notice where the path bends next, and what is just out of sight.']);
  assert.equal(dry.length, 6);
  const none = noticeOptions({ activity: 'garden', words: null, seasonName: 'unknown', part: 'unknown' });
  assert.equal(none[0], 'Touch the soil and notice whether it is dry or damp.');
  assert.ok(none.length <= 6);
});

test('fallback choice is deterministic and admits what it does not know', () => {
  assert.deepEqual(fallbackBring('walk', null), ['a light layer (weather unknown)', 'water', 'comfortable shoes', 'a snack']);
  assert.ok(fallbackBring('hike', { temp: 'cold', rain: 'rain likely', sun: 'weak sun', wind: 'calm' }).includes('a rain jacket (rain likely)'));
  const opts = noticeOptions({ activity: 'walk', words: null, seasonName: 'unknown', part: 'unknown' });
  const d = new Date('2026-10-07T12:00:00Z');
  assert.equal(fallbackNotice(d, opts), fallbackNotice(new Date('2026-10-07T20:00:00Z'), opts));
  assert.ok(opts.includes(fallbackNotice(d, opts)));
});

test('season flips by hemisphere and is unknown without a location', () => {
  const oct = new Date('2026-10-07T12:00:00Z');
  assert.equal(season(oct, 51.5), 'autumn');
  assert.equal(season(oct, -33.9), 'spring');
  assert.equal(season(oct, 1.3), 'tropical (no clear season)');
  assert.equal(season(oct, NaN), 'unknown');
});
