// Sunrise, sunset and solar noon, computed on the device. No network.
//
// Formulas from Astronomy Answers (aa.quae.nl/en/reken/zonpositie.html), the
// same published equations SunCalc uses. Accuracy is about a minute, which is
// plenty for "go outside between these times".

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397;
// Sun's apparent radius plus refraction: the sun "rises" when its centre is
// 0.833 degrees below the horizon.
const H0 = RAD * -0.833;

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date(Math.round((j + 0.5 - J1970) * DAY_MS));
const toDays = (date) => toJulian(date) - J2000;

const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372; // perihelion of the Earth
  return M + C + P + Math.PI;
}

const declination = (L) => Math.asin(Math.sin(L) * Math.sin(OBLIQUITY));
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

/**
 * Sun events for the solar day whose noon is nearest to `date`.
 * Returns { solarNoon, sunrise, sunset } as Dates, or { solarNoon, polar:
 * 'day' | 'night' } when the sun does not cross the horizon that day.
 */
export function sunTimes(date, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError('lat must be in [-90, 90] and lon in [-180, 180]');
  }
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const jNoon = solarTransitJ(ds, M, L);
  const solarNoon = fromJulian(jNoon);

  const cosH = (Math.sin(H0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH > 1) return { solarNoon, polar: 'night' };
  if (cosH < -1) return { solarNoon, polar: 'day' };

  const w = Math.acos(cosH);
  const jSet = solarTransitJ(approxTransit(w, lw, n), M, L);
  const jRise = jNoon - (jSet - jNoon);
  return { solarNoon, sunrise: fromJulian(jRise), sunset: fromJulian(jSet) };
}

/**
 * Daylight intervals that overlap [now, now + hours]. Each is
 * { start: Date, end: Date, polar?: 'day' }. Polar nights add nothing.
 */
export function daylightWindows(now, lat, lon, hours = 24) {
  const horizonEnd = new Date(now.valueOf() + hours * 3600000);
  const seen = new Set();
  const out = [];
  for (const k of [-1, 0, 1, 2]) {
    const t = sunTimes(new Date(now.valueOf() + k * DAY_MS), lat, lon);
    const key = Math.round(t.solarNoon.valueOf() / 60000);
    if (seen.has(key)) continue;
    seen.add(key);
    let start;
    let end;
    if (t.polar === 'night') continue;
    if (t.polar === 'day') {
      start = new Date(t.solarNoon.valueOf() - DAY_MS / 2);
      end = new Date(t.solarNoon.valueOf() + DAY_MS / 2);
    } else {
      start = t.sunrise;
      end = t.sunset;
    }
    if (end <= now || start >= horizonEnd) continue;
    out.push({ start, end, ...(t.polar ? { polar: t.polar } : {}) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
