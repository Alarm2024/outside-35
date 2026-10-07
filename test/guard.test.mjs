import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModelOutput } from '../src/lib/guard.js';
import { bringOptions, buildPrompt, conditionWords, fallbackBring, fallbackNotice, normItem, season } from '../src/lib/plan.js';

const cool = conditionWords({ minTemp: 12, maxTemp: 16, maxPop: 10, maxUv: 2, maxWind: 25, thunder: false }); // cool, dry, weak sun, breezy
const walk = bringOptions('walk', cool).optional;
const ok = 'BRING: water, a snack, comfortable shoes\nNOTICE: Look for a bird landing on the nearest tree.';

const check = (text, words = cool, options = walk) => checkModelOutput(text, { words, options });

test('accepts three picks from the list and one sentence', () => {
  const r = check(ok);
  assert.equal(r.bring.ok, true);
  assert.deepEqual(r.bring.picks, ['water', 'a snack', 'comfortable shoes']);
  assert.deepEqual(r.bring.dropped, []);
  assert.equal(r.notice.ok, true);
  assert.match(r.notice.text, /bird/);
});

test('tolerates markdown, articles, case, plurals and loose labels', () => {
  const r = check('**BRING:** Water, snacks, the notebook.\n- **Noticeable:** Listen for the quietest sound nearby.');
  assert.deepEqual(r.bring.picks, ['water', 'a snack', 'a notebook']);
  assert.equal(r.notice.text, 'Listen for the quietest sound nearby.');
});

test('drops things that are not on the list, and says which', () => {
  const r = check('BRING: water, a kite, sunglasses\nNOTICE: Watch one tree for a whole minute.');
  assert.deepEqual(r.bring.picks, ['water', 'sunglasses']);
  assert.deepEqual(r.bring.dropped, ['a kite']);
});

test('copying the whole list is not choosing (real answer, second CI run)', () => {
  const r = check('BRING: water, comfortable shoes, a snack, sunglasses, a small bag, a notebook.\nNOTICE: Look for the tallest tree on your way.');
  assert.equal(r.bring.ok, false);
  assert.match(r.bring.reason, /listed 6 things/);
  assert.equal(r.notice.ok, true, 'a good NOTICE is still used');
});

test('rejects sentences in BRING (real answers from CI runs)', () => {
  for (const bring of [
    'A warm sweater is essential for staying cool and wet.',
    'A gentle breeze is blowing, making it feel cool and refreshing.',
    'A good quality pair of hiking boots with ankle support is essential for navigating any terrain.',
  ]) {
    const r = check(`BRING: ${bring}\nNOTICE: Look at the tallest tree you can see.`);
    assert.equal(r.bring.ok, false, bring);
    assert.match(r.bring.reason, /from the list/);
  }
});

test('rejects any number, even a plausible one', () => {
  const r = check('BRING: water, a snack\nNOTICE: It is 18 degrees, look at the sky.');
  assert.equal(r.notice.ok, false);
  assert.match(r.notice.reason, /number/);
  assert.equal(r.bring.ok, true);
});

test('NOTICE must name something to notice, not repeat the prompt (real answers)', () => {
  for (const n of [
    'The weather is described as "cool, dry, weak sun," with a "calm" season.',
    'observe a bird, a tree or the sky.',
    'Write one short sentence about a bird.',
  ]) {
    const r = check(`BRING: water, a snack\nNOTICE: ${n}`);
    assert.equal(r.notice.ok, false, n);
    assert.match(r.notice.reason, /repeated the prompt/);
  }
});

test('with no weather data, any weather word in NOTICE is a guess', () => {
  const opts = bringOptions('walk', null).optional;
  for (const n of ['A gentle breeze is blowing through the trees.', 'It will rain later, watch the clouds.', 'Enjoy the warm afternoon sun on your face.', 'The sky looks cloudy and grey today.']) {
    const r = check(`BRING: water, a snack\nNOTICE: ${n}`, null, opts);
    assert.equal(r.notice.ok, false, n);
    assert.match(r.notice.reason, /no weather data/);
  }
  assert.equal(check('BRING: water, a snack\nNOTICE: Look for the first bird you can hear.', null, opts).notice.ok, true);
});

test('with weather data, a weather word must match what the model was given', () => {
  const breeze = 'BRING: water, a snack\nNOTICE: Watch the leaves move in the breeze.';
  assert.equal(check(breeze).notice.ok, true);
  const calm = { ...cool, wind: 'calm' };
  const r = check(breeze, calm, bringOptions('walk', calm).optional);
  assert.equal(r.notice.ok, false);
  assert.match(r.notice.reason, /breeze/);
  // Cloud cover is never given to the model, so it may never claim it.
  assert.equal(check('BRING: water, a snack\nNOTICE: The overcast sky looks soft today.').notice.ok, false);
});

test('missing lines, links and empty answers', () => {
  const r = check('NOTICE: the sky is wide today');
  assert.match(r.bring.reason, /no BRING line/);
  assert.equal(check('BRING: thing, thing, thing\nNOTICE: sentence').notice.ok, false);
  assert.equal(check('BRING: water, a snack\nNOTICE: see https://example.com for birds').notice.ok, false);
  assert.match(check('').notice.reason, /nothing/);
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
