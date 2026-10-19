import type { TicketStatus, User } from '@prisma/client';
import type { Messenger, Screen } from '../types/messenger';
import { statusChangedText } from '../messages/ticket.messages';
import type { TicketWithRelations } from '../repositories/ticket.repository';
import type { Logger } from '../utils/logger';
import { adminTicketKeyboardFor, userTicketKeyboardFor } from '../keyboards/ticket-card.keyboard';
import { adminTicketCard } from '../messages/ticket.messages';
import type { UserService } from './user.service';
import { sleep } from '../utils/sleep';
import { MAX_API } from '../config/constants';

export class NotificationService {
  constructor(
    private readonly messenger: Messenger,
    private readonly users: UserService,
    private readonly log: Logger,
  ) {}

  private async send(to: User, screen: Screen, ticketId?: number): Promise<void> {
    const ok = await this.messenger.sendToUser(to.maxUserId, screen);
    if (!ok) this.log.error({ ticketId, userId: to.id }, 'notification delivery failed');
  }

  /** Все активные администраторы получают уведомление о новой заявке. */
  async notifyAdminsNewTicket(ticket: TicketWithRelations): Promise<void> {
    const admins = await this.users.listActiveAdmins();
    for (const admin of admins) {
      await this.send(
        admin,
        {
          text: `🆕 Новая заявка\n\n${adminTicketCard(ticket)}`,
          keyboard: adminTicketKeyboardFor(ticket, admin),
        },
        ticket.id,
      );
      await sleep(MAX_API.SEND_INTERVAL_MS / 6);
    }
  }

  async notifyUserStatus(ticket: TicketWithRelations, status: TicketStatus): Promise<void> {
    await this.send(
      ticket.user,
      { text: statusChangedText(ticket.number, status), keyboard: userTicketKeyboardFor(ticket) },
      ticket.id,
    );
  }

  async notifyUserComment(ticket: TicketWithRelations, author: User, text: string): Promise<void> {
    await this.send(
      ticket.user,
      { text: `💬 Комментарий к заявке #${ticket.number} (${author.displayName}):\n${text}`, keyboard: userTicketKeyboardFor(ticket) },
      ticket.id,
    );
  }

  async notifyAssigneeUserReply(ticket: TicketWithRelations, text: string): Promise<void> {
    if (!ticket.assignedAdmin) return;
    await this.send(
      ticket.assignedAdmin,
      { text: `💬 Ответ пользователя по заявке #${ticket.number}:\n${text}`, keyboard: adminTicketKeyboardFor(ticket, ticket.assignedAdmin) },
      ticket.id,
    );
  }

  async notifyTransfer(ticket: TicketWithRelations, to: User, from: User): Promise<void> {
    await this.send(
      to,
      {
        text: `🔁 Вам передана заявка #${ticket.number} (от ${from.displayName})\n\n${adminTicketCard(ticket)}`,
        keyboard: adminTicketKeyboardFor(ticket, to),
      },
      ticket.id,
    );
  }
}
