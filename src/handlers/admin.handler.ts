import { CommentVisibility, SessionState, type User } from '@prisma/client';
import { adminTicketKeyboardFor, statusMenuKeyboard } from '../keyboards/ticket-card.keyboard';
import { ticketListKeyboard } from '../keyboards/list.keyboard';
import { MSG } from '../messages/common.messages';
import { adminTicketCard } from '../messages/ticket.messages';
import { cb, type CommentKind, type QueueKind } from '../security/callback-data';
import { commentSchema, parseInput, ticketNumberSchema } from '../security/input';
import type { AdminTicketService } from '../services/admin-ticket.service';
import type { SessionService } from '../services/session.service';
import type { UserService } from '../services/user.service';
import type { TicketStatus } from '@prisma/client';
import { ConflictError } from '../utils/errors';
import { formatDate } from '../utils/text';
import type { Responder } from '../bot/types';
import type { TicketWithRelations } from '../repositories/ticket.repository';

const QUEUE_TITLE: Readonly<Record<QueueKind, string>> = {
  new: '🆕 Новые заявки',
  prog: '🔧 В работе',
  mine: '👤 Мои заявки',
  all: '📋 Все заявки',
};

export class AdminHandler {
  constructor(
    private readonly admin: AdminTicketService,
    private readonly sessions: SessionService,
    private readonly users: UserService,
  ) {}

  private card(admin: User, t: TicketWithRelations) {
    return { text: adminTicketCard(t), keyboard: adminTicketKeyboardFor(t, admin) };
  }

  async queue(admin: User, kind: QueueKind, pageNo: number, res: Responder): Promise<void> {
    const page = await this.admin.queue(admin, kind, pageNo);
    if (page.total === 0) {
      return res.show({ text: `${QUEUE_TITLE[kind]}: пусто.`, keyboard: [[{ text: '⬅️ В меню', payload: cb.menu }]] });
    }
    await res.show({
      text: MSG.queueTitle(QUEUE_TITLE[kind], page.total),
      keyboard: ticketListKeyboard(page, (p) => cb.adminQueue(kind, p)),
    });
  }

  async open(admin: User, number: number, res: Responder): Promise<void> {
    await this.sessions.reset(admin);
    await res.show(this.card(admin, await this.admin.find(admin, number)));
  }

  async startFind(admin: User, res: Responder): Promise<void> {
    await this.sessions.set(admin, SessionState.ENTER_TICKET_NUMBER, {});
    await res.show({ text: MSG.askTicketNumber, keyboard: [[{ text: '✖️ Отмена', payload: cb.menu }]] });
  }

  async onFindText(admin: User, text: string, res: Responder): Promise<void> {
    const n = parseInput(ticketNumberSchema, text);
    if (!n.ok) return res.show({ text: `Введите номер цифрами.\n\n${MSG.askTicketNumber}`, keyboard: [[{ text: '✖️ Отмена', payload: cb.menu }]] });
    await this.sessions.reset(admin);
    await res.show(this.card(admin, await this.admin.find(admin, n.value)));
  }

  async accept(admin: User, number: number, res: Responder): Promise<void> {
    try {
      const ticket = await this.admin.accept(admin, number);
      await res.show(this.card(admin, ticket));
    } catch (err) {
      if (err instanceof ConflictError) {
        // Проигравший гонку видит актуальную карточку, а не ошибку.
        await res.notify(MSG.alreadyTaken);
        return;
      }
      throw err;
    }
  }

  async statusMenu(admin: User, number: number, res: Responder): Promise<void> {
    const t = await this.admin.find(admin, number);
    await res.show({ text: `${adminTicketCard(t)}\n\nНовый статус:`, keyboard: statusMenuKeyboard(t) });
  }

  async setStatus(admin: User, number: number, status: TicketStatus, res: Responder): Promise<void> {
    await res.show(this.card(admin, await this.admin.changeStatus(admin, number, status)));
  }

  async commentMenu(admin: User, number: number, res: Responder): Promise<void> {
    await res.show({
      text: `Заявка #${number}: тип комментария`,
      keyboard: [
        [{ text: '🔒 Внутренний', payload: cb.adminCommentStart(number, 'internal') }],
        [{ text: '👁 Виден пользователю', payload: cb.adminCommentStart(number, 'user') }],
        [{ text: '⬅️ К заявке', payload: cb.ticket(number) }],
      ],
    });
  }

  async commentStart(admin: User, number: number, kind: CommentKind, res: Responder): Promise<void> {
    await this.admin.find(admin, number);
    await this.sessions.set(admin, SessionState.ENTER_COMMENT, { ticketNumber: number, commentKind: kind });
    await res.show({ text: MSG.askComment, keyboard: [[{ text: '✖️ Отмена', payload: cb.ticket(number) }]] });
  }

  async onCommentText(admin: User, number: number, kind: CommentKind, text: string, res: Responder): Promise<void> {
    const parsed = parseInput(commentSchema, text);
    if (!parsed.ok) {
      return res.show({ text: `${parsed.error}\n\n${MSG.askComment}`, keyboard: [[{ text: '✖️ Отмена', payload: cb.ticket(number) }]] });
    }
    const visibility = kind === 'internal' ? CommentVisibility.INTERNAL : CommentVisibility.USER;
    await this.admin.addComment(admin, number, parsed.value, visibility);
    await this.sessions.reset(admin);
    await res.show({ text: MSG.commentSaved, keyboard: [[{ text: '⬅️ К заявке', payload: cb.ticket(number) }]] });
  }

  async transferMenu(admin: User, number: number, res: Responder): Promise<void> {
    const t = await this.admin.find(admin, number);
    const admins = (await this.users.listActiveAdmins()).filter((a) => a.id !== t.assignedAdminId);
    await res.show({
      text: `Заявка #${number}: кому передать?`,
      keyboard: [
        ...admins.map((a) => [{ text: a.displayName, payload: cb.adminTransferTo(number, a.id) }]),
        [{ text: '⬅️ К заявке', payload: cb.ticket(number) }],
      ],
    });
  }

  async transferTo(admin: User, number: number, toAdminId: number, res: Responder): Promise<void> {
    await res.show(this.card(admin, await this.admin.transfer(admin, number, toAdminId)));
  }

  async history(admin: User, number: number, res: Responder): Promise<void> {
    const entries = await this.admin.historyOf(admin, number);
    const lines = entries.map((e) => `${formatDate(e.at)} — ${e.text}`);
    await res.show({
      text: [`История заявки #${number}:`, ...lines].join('\n'),
      keyboard: [[{ text: '⬅️ К заявке', payload: cb.ticket(number) }]],
    });
  }
}
