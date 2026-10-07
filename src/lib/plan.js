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

export function buildPrompt({ activity, words, seasonName, part }) {
  const weatherLine = words
    ? `temperature ${words.temp}, ${words.rain}, ${words.sun}, ${words.wind}`
    : 'unknown (do not describe the weather)';
  return [
    `Someone wants to go outside for ${ACTIVITY_WORDS[activity]}.`,
    `Weather: ${weatherLine}.`,
    `Season: ${seasonName}. Time of day: ${part}.`,
    'Write exactly two lines and nothing else:',
    'BRING: three short things to bring, separated by commas',
    'NOTICE: one short sentence about one thing to notice outside, like a bird, a tree or the sky',
    'Do not write any numbers. Do not predict the weather.',
  ].join('\n');
}

// Built-in text, used when the model is not loaded or its answer fails the
// never-guess check. Plain rules, written by people, chosen by the data.
const BASE_BRING = {
  walk: ['water', 'comfortable shoes'],
  hike: ['water', 'a snack', 'sturdy shoes', 'a charged phone'],
  garden: ['gloves', 'water'],
};

export function fallbackBring(activity, words) {
  const items = [...BASE_BRING[activity]];
  if (!words) {
    items.push('a light layer (weather unknown)');
    return items;
  }
  if (words.rain === 'rain likely' || words.rain === 'thunderstorms possible' || words.rain === 'some chance of rain') items.push('a rain jacket');
  if (words.sun === 'strong sun') items.push('a hat and sunscreen');
  if (['freezing', 'cold', 'cool'].includes(words.temp)) items.push('a warm layer');
  if (['warm', 'hot'].includes(words.temp)) items.push('extra water');
  if (words.wind === 'windy') items.push('a windproof layer');
  return [...new Set(items)];
}

const NOTICE = [
  'Look up once: what shape are the clouds making right now?',
  'Find one tree and notice how its leaves move in the wind.',
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
