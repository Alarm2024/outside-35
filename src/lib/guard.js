// The never-guess check for model output. The model may write words; it may
// not invent facts. Anything that fails is discarded, and the app says so.

const LINE = /^\s*[*_#>\-\s]*\b(bring|notice)\b\s*[*_]*\s*[:\-–]\s*(.+)$/i;
const DIGIT = /[0-9٠-٩۰-۹]/u;
const URL = /https?:|www\./i;
const ITEM_OK = /^[\p{L}\p{M}' &/-]{2,40}$/u;
const WEATHER_CLAIM =
  /\b(will|going to|expect(ed)?|forecast)\b[^.]*\b(rain|shower|snow|storm|thunder|sun|sunny|cloud|clouds|wind|windy|hot|cold|warm|clear)\b/i;

const clean = (s) => s.replace(/[*_`]/g, '').trim();

/**
 * @param {string} text raw model output
 * @param {{ weatherKnown: boolean }} ctx
 * @returns {{ ok: true, bring: string[], notice: string } | { ok: false, reason: string }}
 */
export function checkModelOutput(text, { weatherKnown }) {
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
  if (!weatherKnown && WEATHER_CLAIM.test(both)) {
    return { ok: false, reason: 'it predicted the weather without any weather data' };
  }

  const bring = bringRaw
    .replace(/\.$/, '')
    .split(/\s*[,;]\s*|\s+and\s+/i)
    .map((s) => s.trim().replace(/^(a|an|some)\s+(?=\S)/i, (m) => m.toLowerCase()))
    .filter(Boolean);
  if (bring.length < 1 || bring.length > 5) return { ok: false, reason: 'BRING should list one to five things' };
  const bad = bring.find((item) => !ITEM_OK.test(item));
  if (bad) return { ok: false, reason: `"${bad.slice(0, 40)}" is not a short list item` };

  if (notice.length < 8 || notice.length > 200) return { ok: false, reason: 'NOTICE should be one short sentence' };
  return { ok: true, bring, notice };
}
