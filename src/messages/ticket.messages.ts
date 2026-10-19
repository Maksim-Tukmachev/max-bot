import { CommentVisibility, TicketStatus } from '@prisma/client';
import { formatDate, truncate } from '../utils/text';
import type { TicketWithRelations } from '../repositories/ticket.repository';

export const STATUS_LABEL: Readonly<Record<TicketStatus, string>> = {
  NEW: '🆕 Новая',
  IN_PROGRESS: '🔧 В работе',
  WAITING_USER: '⏳ Ждём ответа',
  POSTPONED: '⏸ Отложена',
  RESOLVED: '✅ Решена',
  CLOSED: '🔒 Закрыта',
};

export const VISIBILITY_LABEL: Readonly<Record<CommentVisibility, string>> = {
  INTERNAL: 'внутренний',
  USER: 'для пользователя',
};

export const ticketLine = (t: TicketWithRelations): string =>
  truncate(`#${t.number} · ${STATUS_LABEL[t.status]} · ${t.branch.name}, ${t.room}`, 60);

const photoLine = (t: TicketWithRelations): string[] => (t._count.attachments > 0 ? [`Фото: ${t._count.attachments}`] : []);

export function userTicketCard(t: TicketWithRelations): string {
  return [
    `Заявка #${t.number}`,
    `Статус: ${STATUS_LABEL[t.status]}`,
    `Филиал: ${t.branch.name}`,
    `Кабинет: ${t.room}`,
    `Проблема: ${t.description}`,
    `Создана: ${formatDate(t.createdAt)}`,
    ...photoLine(t),
    t.assignedAdmin ? `Исполнитель: ${t.assignedAdmin.displayName}` : 'Исполнитель: ещё не назначен',
  ].join('\n');
}

export function adminTicketCard(t: TicketWithRelations): string {
  return [
    `Заявка #${t.number}`,
    `Статус: ${STATUS_LABEL[t.status]}`,
    `Филиал: ${t.branch.name}`,
    `Кабинет: ${t.room}`,
    `Автор: ${t.user.displayName}`,
    `Проблема: ${t.description}`,
    `Создана: ${formatDate(t.createdAt)}`,
    ...photoLine(t),
    t.assignedAdmin ? `Исполнитель: ${t.assignedAdmin.displayName}` : 'Исполнитель: не назначен',
  ].join('\n');
}

export const draftCard = (branchName: string, room: string, description: string, photos = 0): string =>
  ['Проверьте заявку:', `Филиал: ${branchName}`, `Кабинет: ${room}`, `Проблема: ${description}`, ...(photos > 0 ? [`Фото: ${photos}`] : [])].join('\n');

export const statusChangedText = (number: number, status: TicketStatus): string => {
  switch (status) {
    case TicketStatus.IN_PROGRESS:
      return `Заявка #${number} принята в работу`;
    case TicketStatus.CLOSED:
      return `Заявка #${number} выполнена`;
    default:
      return `Заявка #${number}: статус изменён — ${STATUS_LABEL[status]}`;
  }
};
