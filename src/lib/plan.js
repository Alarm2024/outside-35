// The data side of the plan: condition words, what you must bring, and the
// human-written options the model ranks.
//
// The model only ever sees WORDS derived from the data ("cool", "dry"), never
// numbers, and it only ranks lines people wrote and the data allows. Every
// number on screen comes from code. That is how "never guess" survives a
// 270M-parameter model.

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

// What the model ranks. It picks; it does not invent. The first three of each
// list are the built-in choice when the model is not loaded.
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
 * optional: the list the model ranks; its top three are shown.
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

// Built-in choice, used when the model is not loaded. Plain rules, written by
// people, chosen by the data.
export function fallbackBring(activity, words) {
  const { required, optional } = bringOptions(activity, words);
  return [...required.map(requiredLabel), ...optional.slice(0, 3)];
}

// Things to notice, written by people. Each line names the data it depends on;
// code keeps only the lines the data allows (no rain line without a rain
// forecast, no autumn line without a location), and the model ranks the rest.
const NOTICES = [
  { text: 'Listen for the quietest sound around you.' },
  { text: 'Count the different bird calls you can hear.' },
  { text: 'Find one tree and notice the shape of its leaves.' },
  { text: 'Notice the colour of the sky near the horizon, then straight up.' },
  { text: 'Find one small plant growing somewhere it should not be.' },
  { text: 'Look for the first leaves changing colour.', season: ['autumn'] },
  { text: 'Look for new buds on the branches.', season: ['spring'] },
  { text: 'Look at the bare branches against the sky.', season: ['winter'] },
  { text: 'Watch the bees and insects around the flowers.', season: ['summer'] },
  { text: 'Notice your breath in the cold air.', temp: ['cold', 'freezing'] },
  { text: 'Look for frost on the grass and leaves.', temp: ['freezing'] },
  { text: 'Watch how the rain darkens the ground and the bark.', rain: ['rain likely', 'thunderstorms possible'] },
  { text: 'Listen to the wind in the tallest tree you can see.', wind: ['windy', 'breezy'] },
  { text: 'Find a patch of shade and feel how much cooler it is.', sun: ['strong sun'] },
  { text: 'Watch the light change as the sun gets lower.', part: ['afternoon', 'evening'] },
  { text: 'Listen for birds starting their morning songs.', part: ['morning'] },
  { text: 'Touch the soil and notice whether it is dry or damp.', activity: ['garden'] },
  { text: 'Notice where the path bends next, and what is just out of sight.', activity: ['walk', 'hike'] },
];

// At most this many Notice lines go to the model, because each one is one
// more model run (about 0.7 s on a 4-core CPU in CI).
const MAX_NOTICES = 6;

/**
 * The Notice lines this plan's data allows, at most MAX_NOTICES. Weather lines
 * need weather data. Lines tied to this plan's data come first; lines that
 * suit any plan fill the rest.
 */
export function noticeOptions({ activity, words, seasonName, part }, { max = MAX_NOTICES } = {}) {
  const has = (want, value) => !want || (value != null && want.includes(value));
  const allowed = NOTICES.filter((n) => has(n.activity, activity)
    && has(n.season, seasonName)
    && has(n.part, part)
    && has(n.temp, words && words.temp)
    && has(n.rain, words && words.rain)
    && has(n.wind, words && words.wind)
    && has(n.sun, words && words.sun));
  const tied = (n) => Boolean(n.activity || n.season || n.part || n.temp || n.rain || n.wind || n.sun);
  return [...allowed.filter(tied), ...allowed.filter((n) => !tied(n))].slice(0, max).map((n) => n.text);
}

/** Every line any plan can rank, once each (for the model check). */
export function allCandidates() {
  return { bring: [...new Set(Object.values(OPTIONS).flat())], notice: NOTICES.map((n) => n.text) };
}

/** Without the model: one allowed line, the same all day. */
export function fallbackNotice(date, options) {
  const day = Math.floor(date.valueOf() / 86400000);
  return options[day % options.length];
}
