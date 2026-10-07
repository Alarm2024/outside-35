import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModelOutput } from '../src/lib/guard.js';
import { bringOptions, buildPrompt, conditionWords, fallbackBring, fallbackNotice, normItem, season } from '../src/lib/plan.js';

const cool = conditionWords({ minTemp: 12, maxTemp: 16, maxPop: 10, maxUv: 2, maxWind: 25, thunder: false }); // cool, dry, weak sun, breezy
const walk = bringOptions('walk', cool).optional;
const ok = 'BRING: water, a snack, comfortable shoes\nNOTICE: Look for a bird landing on the nearest tree.';

test('accepts three picks from the list and one sentence', () => {
  const r = checkModelOutput(ok, { words: cool, options: walk });
  assert.equal(r.ok, true);
  assert.deepEqual(r.picks, ['water', 'a snack', 'comfortable shoes']);
  assert.deepEqual(r.dropped, []);
  assert.match(r.notice, /bird/);
});

test('tolerates markdown, articles, case and plurals', () => {
  const r = checkModelOutput('**BRING:** Water, snacks, the notebook.\n- **NOTICE:** Listen for the quietest sound nearby.', { words: cool, options: walk });
  assert.equal(r.ok, true);
  assert.deepEqual(r.picks, ['water', 'a snack', 'a notebook']);
});

test('drops things that are not on the list, and says which', () => {
  const r = checkModelOutput('BRING: water, a kite, sunglasses\nNOTICE: Watch one tree for a whole minute.', { words: cool, options: walk });
  assert.equal(r.ok, true);
  assert.deepEqual(r.picks, ['water', 'sunglasses']);
  assert.deepEqual(r.dropped, ['a kite']);
});

test('rejects sentences in BRING (real answers from the first CI run)', () => {
  for (const bring of [
    'A warm sweater is essential for staying cool and wet.',
    'A gentle breeze is blowing, making it feel cool and refreshing.',
  ]) {
    const r = checkModelOutput(`BRING: ${bring}\nNOTICE: Look at the tallest tree you can see.`, { words: cool, options: walk });
    assert.equal(r.ok, false, bring);
    assert.match(r.reason, /from the list/);
  }
});

test('rejects any number, even a plausible one', () => {
  const r = checkModelOutput('BRING: water, a snack\nNOTICE: It is 18 degrees, look at the sky.', { words: cool, options: walk });
  assert.equal(r.ok, false);
  assert.match(r.reason, /number/);
});

test('with no weather data, any weather word in NOTICE is a guess', () => {
  const opts = bringOptions('walk', null).optional;
  for (const n of ['A gentle breeze is blowing through the trees.', 'It will rain later, watch the clouds.', 'Enjoy the warm afternoon sun on your face.', 'The sky is cloudy and grey today.']) {
    const r = checkModelOutput(`BRING: water, a snack\nNOTICE: ${n}`, { words: null, options: opts });
    assert.equal(r.ok, false, n);
    assert.match(r.reason, /no weather data/);
  }
  assert.equal(checkModelOutput('BRING: water, a snack\nNOTICE: Look for the first bird you can hear.', { words: null, options: opts }).ok, true);
});

test('with weather data, a weather word must match what the model was given', () => {
  const breeze = 'BRING: water, a snack\nNOTICE: Watch the leaves move in the breeze.';
  assert.equal(checkModelOutput(breeze, { words: cool, options: walk }).ok, true);
  const calm = { ...cool, wind: 'calm' };
  const r = checkModelOutput(breeze, { words: calm, options: bringOptions('walk', calm).optional });
  assert.equal(r.ok, false);
  assert.match(r.reason, /breeze/);
  // Cloud cover is never given to the model, so it may never claim it.
  assert.equal(checkModelOutput('BRING: water, a snack\nNOTICE: The overcast sky looks soft today.', { words: cool, options: walk }).ok, false);
});

test('rejects echoes of the prompt, missing lines and links', () => {
  assert.equal(checkModelOutput('BRING: thing, thing, thing\nNOTICE: sentence', { words: cool, options: walk }).ok, false);
  assert.match(checkModelOutput('BRING: water, a snack\nNOTICE: Write one short sentence about a bird.', { words: cool, options: walk }).reason, /instructions/);
  assert.equal(checkModelOutput('NOTICE: the sky is wide today', { words: cool, options: walk }).ok, false);
  assert.equal(checkModelOutput('BRING: water, a snack\nNOTICE: see https://example.com for birds', { words: cool, options: walk }).ok, false);
  assert.equal(checkModelOutput('', { words: cool, options: walk }).ok, false);
});

test('the data decides what is required; the model only picks from the rest', () => {
  const sunny = conditionWords({ minTemp: 22, maxTemp: 29, maxPop: 0, maxUv: 8, maxWind: 8, thunder: false });
  const g = bringOptions('garden', sunny);
  assert.deepEqual(g.required.map((r) => r.item), ['a hat', 'sunscreen', 'extra water']);
  assert.ok(!g.optional.includes('a hat'), 'a required item is not offered again');
  assert.deepEqual(bringOptions('walk', null).required, [{ item: 'a light layer', why: 'weather unknown' }]);
  assert.equal(normItem('The Notebook.'), 'notebook');
});

test('the prompt carries no numbers, lists the options and what is already packed', () => {
  const words = conditionWords({ minTemp: 3, maxTemp: 9, maxPop: 70, maxUv: 1, maxWind: 25, thunder: false });
  const hike = buildPrompt({ activity: 'hike', words, seasonName: 'autumn', part: 'morning' });
  assert.match(hike, /Already packed: a rain jacket, a warm layer\./);
  assert.match(hike, /from this list: water, sturdy shoes, a charged phone/);
  const unknown = buildPrompt({ activity: 'walk', words: null, seasonName: 'unknown', part: 'unknown' });
  assert.match(unknown, /Weather: unknown\./);
  for (const p of [hike, unknown]) assert.doesNotMatch(p, /[0-9]/, p);
});

test('condition words come from thresholds', () => {
  assert.deepEqual(conditionWords({ minTemp: 3, maxTemp: 9, maxPop: 40, maxUv: 1, maxWind: 25, thunder: false }), {
    temp: 'cold', rain: 'some chance of rain', sun: 'weak sun', wind: 'breezy',
  });
  assert.equal(conditionWords({ minTemp: null, maxTemp: null, maxPop: null, maxUv: null, maxWind: null, thunder: false }).temp, 'unknown');
});

test('fallback text is deterministic and admits what it does not know', () => {
  assert.deepEqual(fallbackBring('walk', null), ['a light layer (weather unknown)', 'water', 'comfortable shoes', 'a snack']);
  assert.ok(fallbackBring('hike', { temp: 'cold', rain: 'rain likely', sun: 'weak sun', wind: 'calm' }).includes('a rain jacket (rain likely)'));
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
