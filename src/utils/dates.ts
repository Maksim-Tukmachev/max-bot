/** Календарные даты в заданном часовом поясе в формате YYYY-MM-DD. */
export function localDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(day: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

/** «2026-10-07» → «07.10». */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${d}.${m}`;
}

/** Секунды → «2 д 3 ч», «5 ч 10 мин», «12 мин»; null → «—». */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${Math.max(minutes, s > 0 ? 1 : 0)} мин`;
}

function offsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Момент начала календарного дня `day` (YYYY-MM-DD) в часовом поясе `tz`. */
export function startOfLocalDay(day: string, tz: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}
