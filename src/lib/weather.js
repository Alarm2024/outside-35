// Weather from Open-Meteo (free, no account, no API key). Only fetched when the
// user taps "Check weather", and only with coordinates rounded to two decimals
// (about 1 km), so the exact position never leaves the device.

export const WEATHER_MAX_AGE_MS = 3 * 3600000;
export const WEATHER_SOURCE = 'Open-Meteo (open-meteo.com)';

const FIELDS = ['temperature_2m', 'precipitation_probability', 'uv_index', 'wind_speed_10m', 'weather_code'];

export const round2 = (x) => Math.round(x * 100) / 100;

export function forecastUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(round2(lat)),
    longitude: String(round2(lon)),
    hourly: FIELDS.join(','),
    forecast_days: '2',
    timezone: 'GMT',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turn an Open-Meteo response into { hours: [{ t: Date, temp, pop, uv, wind, code }] }. */
export function parseForecast(json, fetchedAt) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time) || h.time.length === 0) {
    throw new Error('forecast has no hourly data');
  }
  const col = (name) => (Array.isArray(h[name]) && h[name].length === h.time.length ? h[name] : null);
  const temp = col('temperature_2m');
  const pop = col('precipitation_probability');
  const uv = col('uv_index');
  const wind = col('wind_speed_10m');
  const code = col('weather_code');
  const hours = h.time.map((s, i) => ({
    t: new Date(s * 1000),
    temp: temp ? num(temp[i]) : null,
    pop: pop ? num(pop[i]) : null,
    uv: uv ? num(uv[i]) : null,
    wind: wind ? num(wind[i]) : null,
    code: code ? num(code[i]) : null,
  }));
  return { fetchedAt: new Date(fetchedAt), hours };
}

export async function fetchForecast(lat, lon, fetchImpl = fetch, now = new Date()) {
  const res = await fetchImpl(forecastUrl(lat, lon));
  if (!res.ok) throw new Error(`Open-Meteo answered HTTP ${res.status}`);
  return parseForecast(await res.json(), now);
}

/**
 * Is this forecast usable right now? Returns { known: true, forecast } or
 * { known: false, reason }. Never stretches an old forecast to fill a gap.
 */
export function weatherState(forecast, now, { online = true, reasonIfMissing } = {}) {
  if (!forecast) {
    const reason = reasonIfMissing || (online ? 'not fetched yet (tap Check weather)' : 'no signal, and no recent forecast on this device');
    return { known: false, reason };
  }
  const age = now - forecast.fetchedAt;
  if (age > WEATHER_MAX_AGE_MS) {
    const hours = Math.floor(age / 3600000);
    return { known: false, reason: `the last forecast on this device is ${hours} h old (older than 3 h)` };
  }
  return { known: true, forecast };
}

/** Serialise for localStorage (Dates as ms). */
export const forecastToJSON = (f) => ({
  fetchedAt: f.fetchedAt.valueOf(),
  hours: f.hours.map((h) => ({ ...h, t: h.t.valueOf() })),
});

export const forecastFromJSON = (o) => ({
  fetchedAt: new Date(o.fetchedAt),
  hours: o.hours.map((h) => ({ ...h, t: new Date(h.t) })),
});
