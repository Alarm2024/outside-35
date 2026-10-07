// What the model is told, and what we say when the model is not there.
//
// The model only ever sees WORDS derived from the data ("cool", "dry"), never
// numbers, and is asked to write no numbers. Every number on screen comes from
// code. That is how "never guess" survives a 270M-parameter model.

export function conditionWords(facts) {
  if (!facts) return null;
  const w = {};
  if (facts.minTemp === null || facts.maxTemp === null) w.temp = 'unknown';
  else if (facts.minTemp <= 0) w.temp = 'freezing';
  else if (facts.minTemp < 10) w.temp = 'cold';
  else if (facts.maxTemp <= 17) w.temp = 'cool';
  else if (facts.maxTemp <= 24) w.temp = 'mild';
  else if (facts.maxTemp <= 30) w.temp = 'warm';
  else w.temp = 'hot';

  if (facts.maxPop === null) w.rain = 'unknown';
  else if (facts.thunder) w.rain = 'thunderstorms possible';
  else if (facts.maxPop >= 60) w.rain = 'rain likely';
  else if (facts.maxPop >= 30) w.rain = 'some chance of rain';
  else w.rain = 'dry';

  if (facts.maxUv === null) w.sun = 'unknown';
  else if (facts.maxUv >= 6) w.sun = 'strong sun';
  else if (facts.maxUv >= 3) w.sun = 'some sun';
  else w.sun = 'weak sun';

  if (facts.maxWind === null) w.wind = 'unknown';
  else if (facts.maxWind >= 40) w.wind = 'windy';
  else if (facts.maxWind >= 20) w.wind = 'breezy';
  else w.wind = 'calm';
  return w;
}

/** Season from the date and the hemisphere. Unknown without a location. */
export function season(date, lat) {
  if (!Number.isFinite(lat)) return 'unknown';
  if (Math.abs(lat) < 15) return 'tropical (no clear season)';
  const m = date.getUTCMonth(); // 0 = January
  const north = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][m];
  if (lat > 0) return north;
  return { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' }[north];
}

export function timeOfDay(start, solarNoon) {
  if (!start || !solarNoon) return 'unknown';
  const h = (start - solarNoon) / 3600000;
  if (h < -3) return 'morning';
  if (h < 2) return 'midday';
  if (h < 5) return 'afternoon';
  return 'evening';
}

const ACTIVITY_WORDS = { walk: 'a short walk', hike: 'a hike', garden: 'time in the garden' };

// What the model may choose from. It picks; it does not invent. The first three
// of each list are the built-in choice when the model is not used.
const OPTIONS = {
  walk: ['water', 'comfortable shoes', 'a snack', 'sunglasses', 'a small bag', 'a notebook'],
  hike: ['water', 'sturdy shoes', 'a charged phone', 'a snack', 'a map', 'a first aid kit', 'a torch'],
  garden: ['gloves', 'water', 'a kneeling pad', 'a hat', 'a trowel', 'a watering can'],
};

/** Lower case, no article, no trailing punctuation: how bring items are compared. */
export function normItem(s) {
  return String(s)
    .toLowerCase()
    .replace(/[.!*_`"]+$/g, '')
    .replace(/^(a|an|some|the)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The bring list, decided by code from the data.
 * required: always shown, each with the reason (from the data, or "weather unknown").
 * optional: the list the model picks three from.
 */
export function bringOptions(activity, words) {
  const required = [];
  if (!words) {
    required.push({ item: 'a light layer', why: 'weather unknown' });
  } else {
    if (['rain likely', 'thunderstorms possible', 'some chance of rain'].includes(words.rain)) required.push({ item: 'a rain jacket', why: words.rain });
    if (words.sun === 'strong sun') required.push({ item: 'a hat', why: 'strong sun' }, { item: 'sunscreen', why: 'strong sun' });
    if (['freezing', 'cold', 'cool'].includes(words.temp)) required.push({ item: 'a warm layer', why: words.temp });
    if (['warm', 'hot'].includes(words.temp)) required.push({ item: 'extra water', why: words.temp });
    if (words.wind === 'windy') required.push({ item: 'a windproof layer', why: 'windy' });
  }
  const taken = new Set(required.map((r) => normItem(r.item)));
  const optional = OPTIONS[activity].filter((o) => !taken.has(normItem(o)));
  return { required, optional };
}

export const requiredLabel = (r) => `${r.item} (${r.why})`;

export function buildPrompt({ activity, words, seasonName, part, options = bringOptions(activity, words) }) {
  const weatherLine = words ? `${words.temp}, ${words.rain}, ${words.sun}, ${words.wind}` : 'unknown';
  const lines = [
    `Plan: ${ACTIVITY_WORDS[activity]} outside.`,
    `Weather: ${weatherLine}.`,
    `Season: ${seasonName}. Time of day: ${part}.`,
  ];
  if (options.required.length) lines.push(`Already packed: ${options.required.map((r) => r.item).join(', ')}.`);
  lines.push(
    `Pick the three most useful things to bring from this list: ${options.optional.join(', ')}.`,
    'Then write one short sentence about one thing to look at or listen to outside, like a bird, a tree or the sky.',
    'Reply in exactly this format:',
    'BRING: thing, thing, thing',
    'NOTICE: sentence',
  );
  return lines.join('\n');
}

// Built-in text, used when the model is not loaded or its answer fails the
// never-guess check. Plain rules, written by people, chosen by the data.
export function fallbackBring(activity, words) {
  const { required, optional } = bringOptions(activity, words);
  return [...required.map(requiredLabel), ...optional.slice(0, 3)];
}

const NOTICE = [
  'Look up once: what is moving in the sky right now?',
  'Find one tree and notice the shape of its leaves.',
  'Stop for a moment and count the different bird calls you can hear.',
  'Notice the colour of the sky near the horizon versus straight up.',
  'Find one small plant growing somewhere it should not be.',
  'Watch where the light lands: which side of the street is brighter?',
  'Listen for the quietest sound around you.',
];

export function fallbackNotice(date) {
  const day = Math.floor(date.valueOf() / 86400000);
  return NOTICE[day % NOTICE.length];
}
