// Every time is shown twice: UTC first, then this device's own time zone.

const pad = (n) => String(n).padStart(2, '0');

export function hhmmUTC(d) {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function dayUTC(d, now) {
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return d.toISOString().slice(0, 10);
}

export function localTime(d, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

export function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'device time';
  } catch {
    return 'device time';
  }
}

/** "14:00–14:45 UTC (today) · 16:00–16:45 Europe/Berlin" */
export function rangeLabel(start, end, now, timeZone) {
  const utc = `${hhmmUTC(start)}–${hhmmUTC(end)} UTC (${dayUTC(start, now)})`;
  const zone = timeZone || deviceZone();
  const local = `${localTime(start, timeZone)}–${localTime(end, timeZone)} ${zone}`;
  return { utc, local };
}
