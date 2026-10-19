import { TicketStatus } from '@prisma/client';

/** Единственный источник правды о допустимых сменах статуса (кнопки и проверки сервиса). */
const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  NEW: [TicketStatus.IN_PROGRESS],
  IN_PROGRESS: [TicketStatus.WAITING_USER, TicketStatus.POSTPONED, TicketStatus.RESOLVED, TicketStatus.CLOSED],
  WAITING_USER: [TicketStatus.IN_PROGRESS, TicketStatus.POSTPONED, TicketStatus.RESOLVED],
  POSTPONED: [TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED],
  RESOLVED: [TicketStatus.CLOSED, TicketStatus.IN_PROGRESS],
  CLOSED: [],
};

export function allowedTransitions(from: TicketStatus): readonly TicketStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const ACTIVE_STATUSES: readonly TicketStatus[] = [
  TicketStatus.NEW,
  TicketStatus.IN_PROGRESS,
  TicketStatus.WAITING_USER,
  TicketStatus.POSTPONED,
  TicketStatus.RESOLVED,
];

export const CLOSED_STATUSES: readonly TicketStatus[] = [TicketStatus.CLOSED];

/** Статусы «в работе» для очереди администратора. */
export const IN_WORK_STATUSES: readonly TicketStatus[] = [
  TicketStatus.IN_PROGRESS,
  TicketStatus.WAITING_USER,
  TicketStatus.POSTPONED,
];
