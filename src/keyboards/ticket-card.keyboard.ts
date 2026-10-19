import { Role, TicketStatus, type User } from '@prisma/client';
import { allowedTransitions } from '../domain/ticket-transitions';
import { cb } from '../security/callback-data';
import type { TicketWithRelations } from '../repositories/ticket.repository';
import type { KeyboardDef } from '../types/messenger';
import { STATUS_LABEL } from '../messages/ticket.messages';

const HOME = { text: '⬅️ В меню', payload: cb.menu };

export function userTicketKeyboardFor(t: TicketWithRelations): KeyboardDef {
  const rows: KeyboardDef = [];
  if (t._count.attachments > 0) rows.push([{ text: `🖼 Фото (${t._count.attachments})`, payload: cb.ticketPhotos(t.number) }]);
  if (t.status === TicketStatus.WAITING_USER) rows.push([{ text: '✍️ Ответить', payload: cb.ticketReply(t.number) }]);
  rows.push([HOME]);
  return rows;
}

/** Кнопки формируются из роли и статуса; при нажатии всё проверяется на сервере повторно. */
export function adminTicketKeyboardFor(t: TicketWithRelations, admin: User): KeyboardDef {
  const rows: KeyboardDef = [];
  const isOwner = t.assignedAdminId === admin.id;
  const canManage = isOwner || admin.role === Role.SUPERADMIN;
  if (t._count.attachments > 0) rows.push([{ text: `🖼 Фото (${t._count.attachments})`, payload: cb.ticketPhotos(t.number) }]);

  if (t.status === TicketStatus.NEW) {
    rows.push([{ text: '✅ Принять', payload: cb.adminAccept(t.number) }]);
  } else if (canManage && allowedTransitions(t.status).length > 0) {
    const label = t.status === TicketStatus.WAITING_USER || t.status === TicketStatus.POSTPONED || t.status === TicketStatus.RESOLVED
      ? '🔄 Изменить статус / вернуть в работу'
      : '🔄 Изменить статус';
    rows.push([{ text: label, payload: cb.adminStatusMenu(t.number) }]);
  }
  rows.push([{ text: '💬 Добавить комментарий', payload: cb.adminCommentMenu(t.number) }]);
  if (canManage && t.status !== TicketStatus.NEW && t.status !== TicketStatus.CLOSED) {
    rows.push([{ text: '🔁 Передать', payload: cb.adminTransferMenu(t.number) }]);
  }
  rows.push([{ text: '📜 История', payload: cb.adminHistory(t.number) }]);
  rows.push([HOME]);
  return rows;
}

export function statusMenuKeyboard(t: TicketWithRelations): KeyboardDef {
  const rows: KeyboardDef = allowedTransitions(t.status).map((s) => [
    { text: STATUS_LABEL[s], payload: cb.adminStatusSet(t.number, s) },
  ]);
  rows.push([{ text: '⬅️ К заявке', payload: cb.ticket(t.number) }]);
  return rows;
}
