/** Часовой пояс отчётов и дат в сообщениях (переменная REPORT_TIMEZONE, по умолчанию Москва). */
export const DEFAULT_TIMEZONE = 'Europe/Moscow';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const REPORT_TZ: string = (() => {
  const tz = process.env.REPORT_TIMEZONE?.trim();
  return tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
})();
