import { cb } from '../security/callback-data';
import type { TicketWithRelations } from '../repositories/ticket.repository';
import type { Page } from '../services/ticket.service';
import type { KeyboardDef } from '../types/messenger';
import { ticketLine } from '../messages/ticket.messages';

export function ticketListKeyboard(
  page: Page<TicketWithRelations>,
  pageCallback: (p: number) => string,
): KeyboardDef {
  const rows: KeyboardDef = page.items.map((t) => [{ text: ticketLine(t), payload: cb.ticket(t.number) }]);
  const nav = [];
  if (page.page > 0) nav.push({ text: '◀️ Назад', payload: pageCallback(page.page - 1) });
  if (page.page + 1 < page.pages) nav.push({ text: 'Вперёд ▶️', payload: pageCallback(page.page + 1) });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⬅️ В меню', payload: cb.menu }]);
  return rows;
}
