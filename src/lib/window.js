// Picks the time window. Pure rules, no model: the window is a fact we can
// show our working for, so the language model never touches it.

export const ACTIVITIES = {
  walk: { label: 'Walk', minutes: 45 },
  hike: { label: 'Hike', minutes: 180 },
  garden: { label: 'Garden', minutes: 60 },
};

const MIN = 60000;
const HOUR = 3600000;
// Finish this long before sunset, so you are not walking back in the dark.
const SUNSET_MARGIN = 15 * MIN;
const STEP = 15 * MIN;

const ceilTo = (t, step) => Math.ceil(t / step) * step;

/** Hours of the forecast that overlap [start, end). */
function hoursIn(forecast, start, end) {
  return forecast.hours.filter((h) => h.t.valueOf() < end && h.t.valueOf() + HOUR > start);
}

function summarise(hours) {
  const pick = (k) => hours.map((h) => h[k]).filter((v) => v !== null);
  const vals = { temp: pick('temp'), pop: pick('pop'), uv: pick('uv'), wind: pick('wind'), code: pick('code') };
  const unknown = Object.entries(vals).filter(([, v]) => v.length === 0).map(([k]) => k);
  return {
    minTemp: vals.temp.length ? Math.min(...vals.temp) : null,
    maxTemp: vals.temp.length ? Math.max(...vals.temp) : null,
    maxPop: vals.pop.length ? Math.max(...vals.pop) : null,
    maxUv: vals.uv.length ? Math.max(...vals.uv) : null,
    maxWind: vals.wind.length ? Math.max(...vals.wind) : null,
    thunder: vals.code.some((c) => c >= 95),
    unknown,
  };
}

function score(s, activity) {
  let p = 0;
  if (s.maxPop !== null) p += s.maxPop;
  if (s.minTemp !== null && s.minTemp < 10) p += (10 - s.minTemp) * 2;
  if (s.maxTemp !== null && s.maxTemp > 24) p += (s.maxTemp - 24) * 2;
  if (s.maxUv !== null && s.maxUv > 6 && activity !== 'walk') p += (s.maxUv - 6) * 5;
  if (s.maxWind !== null && s.maxWind > 30) p += s.maxWind - 30;
  if (s.thunder) p += 200;
  return p;
}

export function warnings(s) {
  const out = [];
  if (s.thunder) out.push('Thunderstorm in the forecast for this window. Consider another day.');
  if (s.maxPop !== null && s.maxPop >= 70) out.push(`Rain is likely (up to ${s.maxPop}% chance).`);
  if (s.maxUv !== null && s.maxUv >= 8) out.push(`Very strong sun (UV up to ${s.maxUv}).`);
  if (s.maxTemp !== null && s.maxTemp >= 32) out.push(`Hot (up to ${s.maxTemp} °C).`);
  if (s.minTemp !== null && s.minTemp <= 0) out.push(`Freezing (down to ${s.minTemp} °C).`);
  if (s.maxWind !== null && s.maxWind >= 50) out.push(`Strong wind (up to ${s.maxWind} km/h).`);
  return out;
}

/**
 * @param {object} o
 * @param {Date} o.now
 * @param {'walk'|'hike'|'garden'} o.activity
 * @param {{known: true, windows: Array} | {known: false, reason: string}} o.daylight
 * @param {{known: true, forecast: object} | {known: false, reason: string}} o.weather
 */
export function pickWindow({ now, activity, daylight, weather }) {
  const dur = ACTIVITIES[activity].minutes * MIN;
  if (!daylight.known) {
    return { status: 'UNKNOWN', reason: `daylight is unknown: ${daylight.reason}` };
  }
  if (daylight.windows.length === 0) {
    return { status: 'NO_DAYLIGHT', reason: 'the sun stays below the horizon for the next 24 h here' };
  }

  const candidates = [];
  const horizon = now.valueOf() + 24 * HOUR;
  for (const w of daylight.windows) {
    const lastEnd = w.end.valueOf() - (w.polar ? 0 : SUNSET_MARGIN);
    for (let s = ceilTo(Math.max(now.valueOf(), w.start.valueOf()), STEP); s + dur <= lastEnd && s < horizon; s += STEP) {
      candidates.push(s);
    }
  }
  if (candidates.length === 0) {
    return {
      status: 'NO_FIT',
      reason: `no daylight slot of ${ACTIVITIES[activity].minutes} min left in the next 24 h`,
    };
  }

  if (!weather.known) {
    const s = candidates[0];
    return {
      status: 'OK',
      basis: 'sun',
      start: new Date(s),
      end: new Date(s + dur),
      why: `the earliest daylight slot that fits a ${ACTIVITIES[activity].minutes}-min ${activity}`,
      weatherReason: weather.reason,
      warnings: [],
    };
  }

  let best = null;
  for (const s of candidates) {
    const hrs = hoursIn(weather.forecast, s, s + dur);
    if (hrs.length === 0) continue; // outside the forecast: not scored, not guessed
    const sum = summarise(hrs);
    const sc = score(sum, activity);
    if (!best || sc < best.sc) best = { s, sc, sum };
  }
  if (!best) {
    const s = candidates[0];
    return {
      status: 'OK',
      basis: 'sun',
      start: new Date(s),
      end: new Date(s + dur),
      why: `the earliest daylight slot that fits a ${ACTIVITIES[activity].minutes}-min ${activity}`,
      weatherReason: 'the forecast does not cover the daylight slots',
      warnings: [],
    };
  }
  return {
    status: 'OK',
    basis: 'sun+weather',
    start: new Date(best.s),
    end: new Date(best.s + dur),
    why: 'the daylight slot with the lowest rain chance and most comfortable temperature, wind and sun',
    facts: best.sum,
    warnings: warnings(best.sum),
  };
}
