// The never-guess check for model output. The model may write words; it may
// not invent facts. Anything that fails is discarded, and the app says so.

import { normItem } from './plan.js';

// "Notice", "Noticeable", "Notice this": a small model rarely copies a label exactly.
const LINE = /^\s*[*_#>\-\s]*\b(bring|notice\w*)\b(?:\s+\w+)?\s*[*_]*\s*[:\-–]\s*(.+)$/i;
const DIGIT = /[0-9٠-٩۰-۹]/u;
const URL = /https?:|www\./i;
// Echoes of the prompt, not an answer.
const ECHO = /\b(sentence|format|thing, thing|this list|described|season|time of day|weather)\b|a bird,? a tree,? or the sky/i;

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
 * BRING and NOTICE are judged separately: a good sentence is still used when
 * the picks fail, and the other way round.
 * @param {string} text raw model output
 * @param {{ words: object|null, options: string[] }} ctx
 *   words: the condition words the model was given (null = weather UNKNOWN)
 *   options: the list the model was asked to pick from
 * @returns {{
 *   bring: { ok: true, picks: string[], dropped: string[] } | { ok: false, reason: string },
 *   notice: { ok: true, text: string } | { ok: false, reason: string },
 * }}
 */
export function checkModelOutput(text, { words, options }) {
  if (typeof text !== 'string' || !text.trim()) {
    const none = { ok: false, reason: 'the model returned nothing' };
    return { bring: none, notice: none };
  }
  let bringRaw = null;
  let notice = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) continue;
    const key = m[1].toLowerCase().startsWith('bring') ? 'bring' : 'notice';
    if (key === 'bring' && bringRaw === null) bringRaw = clean(m[2]);
    if (key === 'notice' && notice === null) notice = clean(m[2]);
  }
  return { bring: checkBring(bringRaw, options), notice: checkNotice(notice, words) };
}

function invented(s) {
  if (DIGIT.test(s)) return 'it contained a number, and numbers must come from data';
  if (URL.test(s)) return 'it contained a link';
  return null;
}

// Only things from the list. Anything else is dropped; two or three real picks
// must remain. Copying the whole list is not choosing.
function checkBring(raw, options) {
  if (raw === null) return { ok: false, reason: 'there was no BRING line' };
  const bad = invented(raw);
  if (bad) return { ok: false, reason: `BRING: ${bad}` };
  const byNorm = new Map(options.map((o) => [normItem(o), o]));
  const picks = [];
  const dropped = [];
  for (const part of raw.split(/\s*[,;]\s*|\s+and\s+/i)) {
    const n = normItem(part);
    if (!n) continue;
    const hit = byNorm.get(n) ?? byNorm.get(n.replace(/s$/, '')) ?? byNorm.get(`${n}s`);
    if (hit && !picks.includes(hit)) picks.push(hit);
    else if (!hit) dropped.push(part.trim());
  }
  if (picks.length > 3) return { ok: false, reason: `BRING listed ${picks.length} things from the list instead of choosing three` };
  if (picks.length < 2) return { ok: false, reason: 'BRING did not pick at least two things from the list it was given' };
  return { ok: true, picks, dropped };
}

// One plain sentence about something to notice, and no weather it was not given.
function checkNotice(text, words) {
  if (text === null) return { ok: false, reason: 'there was no NOTICE line' };
  const bad = invented(text);
  if (bad) return { ok: false, reason: `NOTICE: ${bad}` };
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4 || text.length > 160) return { ok: false, reason: 'NOTICE should be one short sentence' };
  if (ECHO.test(text)) return { ok: false, reason: 'NOTICE repeated the prompt instead of naming something to notice' };
  for (const c of CLAIMS) {
    const m = text.match(c.re);
    if (m && !(words && c.ok(words))) {
      return {
        ok: false,
        reason: words
          ? `NOTICE says "${m[0]}", which the forecast it was given does not say`
          : `NOTICE says "${m[0]}" with no weather data`,
      };
    }
  }
  return { ok: true, text };
}
