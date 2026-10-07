// The never-guess check for model output. The model may write words; it may
// not invent facts. Anything that fails is discarded, and the app says so.

import { normItem } from './plan.js';

const LINE = /^\s*[*_#>\-\s]*\b(bring|notice)\b\s*[*_]*\s*[:\-–]\s*(.+)$/i;
const DIGIT = /[0-9٠-٩۰-۹]/u;
const URL = /https?:|www\./i;
// Echoes of the prompt, not an answer.
const ECHO = /\b(sentence|format|thing, thing|this list)\b/i;

// A weather word in NOTICE is a claim about the weather. It is allowed only
// when the condition words given to the model say the same thing.
const CLAIMS = [
  { re: /\b(rain\w*|drizzl\w*|showers?|puddles?|umbrellas?)\b/i, ok: (w) => /rain|thunder/.test(w.rain) },
  { re: /\b(thunder\w*|lightning|storm\w*)\b/i, ok: (w) => w.rain === 'thunderstorms possible' },
  { re: /\b(snow\w*|frost\w*|ice|icy|freez\w*)\b/i, ok: (w) => w.temp === 'freezing' },
  { re: /\b(wind\w*|breez\w*|gust\w*)\b/i, ok: (w) => w.wind === 'windy' || w.wind === 'breezy' },
  { re: /\b(sunny|sunshine|sun is shining|bright sun)\b/i, ok: (w) => w.sun === 'strong sun' || w.sun === 'some sun' },
  { re: /\b(hot|heat|warm\w*)\b/i, ok: (w) => w.temp === 'warm' || w.temp === 'hot' },
  { re: /\b(cold|chilly|cool|crisp)\b/i, ok: (w) => ['cold', 'cool', 'freezing'].includes(w.temp) },
  // Cloud cover, fog and humidity are never given to the model.
  { re: /\b(cloudy|overcast|grey sky|gray sky|fog\w*|mist|misty|humid\w*|forecast)\b/i, ok: () => false },
];

const clean = (s) => s.replace(/[*_`]/g, '').trim();

/**
 * @param {string} text raw model output
 * @param {{ words: object|null, options: string[] }} ctx
 *   words: the condition words the model was given (null = weather UNKNOWN)
 *   options: the list the model was asked to pick from
 * @returns {{ ok: true, picks: string[], dropped: string[], notice: string } | { ok: false, reason: string }}
 */
export function checkModelOutput(text, { words, options }) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'the model returned nothing' };

  let bringRaw = null;
  let notice = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'bring' && bringRaw === null) bringRaw = clean(m[2]);
    if (key === 'notice' && notice === null) notice = clean(m[2]);
  }
  if (bringRaw === null || notice === null) {
    return { ok: false, reason: 'the answer did not have a BRING line and a NOTICE line' };
  }

  const both = `${bringRaw}\n${notice}`;
  if (DIGIT.test(both)) return { ok: false, reason: 'it contained a number, and numbers must come from data' };
  if (URL.test(both)) return { ok: false, reason: 'it contained a link' };

  // BRING: only things from the list. Anything else is dropped, and at least
  // two real picks must remain.
  const byNorm = new Map(options.map((o) => [normItem(o), o]));
  const picks = [];
  const dropped = [];
  for (const part of bringRaw.split(/\s*[,;]\s*|\s+and\s+/i)) {
    const n = normItem(part);
    if (!n) continue;
    const hit = byNorm.get(n) ?? byNorm.get(n.replace(/s$/, '')) ?? byNorm.get(`${n}s`);
    if (hit && !picks.includes(hit)) picks.push(hit);
    else if (!hit) dropped.push(part.trim());
  }
  if (picks.length < 2) return { ok: false, reason: 'BRING did not pick at least two things from the list it was given' };

  // NOTICE: one plain sentence, no weather it was not given.
  const wordCount = notice.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4 || notice.length > 160) return { ok: false, reason: 'NOTICE should be one short sentence' };
  if (ECHO.test(notice)) return { ok: false, reason: 'NOTICE repeated the instructions instead of answering' };
  for (const c of CLAIMS) {
    const m = notice.match(c.re);
    if (m && !(words && c.ok(words))) {
      return {
        ok: false,
        reason: words
          ? `NOTICE says "${m[0]}", which the forecast it was given does not say`
          : `NOTICE says "${m[0]}" with no weather data`,
      };
    }
  }
  return { ok: true, picks: picks.slice(0, 3), dropped, notice };
}
