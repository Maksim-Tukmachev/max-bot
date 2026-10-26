import { TicketStatus } from '@prisma/client';
import type { DayRow, EmployeeRow, Overview, RequesterRow, WeekRow } from '../repositories/stats.repository';
import type { Ranged } from '../services/stats.service';
import { addDays, formatDuration, shortDay } from '../utils/dates';
import { STATUS_LABEL } from './ticket.messages';

const PERIOD_TITLE: Record<number, string> = { 1: 'сегодня', 7: 'за 7 дней', 14: 'за 14 дней', 30: 'за 30 дней' };

const periodLabel = (days: number): string => PERIOD_TITLE[days] ?? `за ${days} дн.`;
const rangeLabel = (fromDay: string, toDay: string): string => {
  const last = addDays(toDay, -1);
  return fromDay === last ? shortDay(fromDay) : `${shortDay(fromDay)}–${shortDay(last)}`;
};

export function overviewText(r: Ranged<Overview>): string {
  const o = r.data;
  const lines = [
    `📊 Статистика ${periodLabel(r.days)} (${rangeLabel(r.range.fromDay, r.range.toDay)})`,
    '',
    `Создано заявок: ${o.created}`,
    `Закрыто заявок: ${o.closed}`,
    `Среднее время до принятия: ${formatDuration(o.avgAcceptSeconds)}`,
    `Среднее время до закрытия: ${formatDuration(o.avgCloseSeconds)}`,
    '',
    'Сейчас в системе:',
    ...(Object.values(TicketStatus) as TicketStatus[]).map((s) => `${STATUS_LABEL[s]}: ${o.current[s] ?? 0}`),
  ];
  if (o.byBranch.length > 0) {
    lines.push('', 'По филиалам (создано):', ...o.byBranch.map((b) => `• ${b.name}: ${b.count}`));
  }
  return lines.join('\n');
}

export function dailyText(r: Ranged<DayRow[]>): string {
  const totalCreated = r.data.reduce((s, d) => s + d.created, 0);
  const totalClosed = r.data.reduce((s, d) => s + d.closed, 0);
  return [
    `📅 По дням (${rangeLabel(r.range.fromDay, r.range.toDay)})`,
    'дата — создано / закрыто',
    '',
    ...[...r.data].reverse().map((d) => `${shortDay(d.day)} — ${d.created} / ${d.closed}`),
    '',
    `Итого: ${totalCreated} / ${totalClosed}`,
  ].join('\n');
}

export function weeklyText(weeks: number, rows: WeekRow[]): string {
  const totalCreated = rows.reduce((s, d) => s + d.created, 0);
  const totalClosed = rows.reduce((s, d) => s + d.closed, 0);
  return [
    `🗓 По неделям (последние ${weeks})`,
    'неделя с понедельника — создано / закрыто',
    '',
    ...[...rows].reverse().map((w) => `${shortDay(w.weekStart)}–${shortDay(addDays(w.weekStart, 6))} — ${w.created} / ${w.closed}`),
    '',
    `Итого: ${totalCreated} / ${totalClosed}`,
  ].join('\n');
}

export function staffText(r: Ranged<EmployeeRow[]> & { onlyOwn: boolean }): string {
  const head = `👥 Сотрудники ${periodLabel(r.days)} (${rangeLabel(r.range.fromDay, r.range.toDay)})`;
  if (r.data.length === 0) return `${head}\n\nДанных нет.`;
  const blocks = r.data.map((e) =>
    [
      `• ${e.name}`,
      `  принял: ${e.accepted} (в среднем за ${formatDuration(e.avgAcceptSeconds)})`,
      `  выполнил: ${e.done} (в среднем за ${formatDuration(e.avgDoneSeconds)})`,
      `  сейчас в работе: ${e.load}`,
    ].join('\n'),
  );
  return [head, ...(r.onlyOwn ? ['(показаны только ваши данные)'] : []), '', ...blocks].join('\n');
}

export function requestersText(r: Ranged<RequesterRow[]>): string {
  const head = `📨 Кто чаще обращается ${periodLabel(r.days)} (${rangeLabel(r.range.fromDay, r.range.toDay)})`;
  if (r.data.length === 0) return `${head}\n\nДанных нет.`;
  return [head, '', ...r.data.map((u, i) => `${i + 1}. ${u.name} — ${u.count}`)].join('\n');
}
