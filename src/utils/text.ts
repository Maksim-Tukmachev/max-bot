import { LIMITS } from '../config/constants';
import { REPORT_TZ } from '../config/timezone';

/** Убирает управляющие символы, схлопывает пробелы, обрезает края. */
export function normalizeText(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function splitMessage(text: string, max: number = LIMITS.MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: REPORT_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
