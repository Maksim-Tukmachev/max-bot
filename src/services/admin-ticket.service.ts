import { CommentVisibility, Role, TicketStatus, type PrismaClient, type User } from '@prisma/client';
import { LIMITS } from '../config/constants';
import { AuditAction, AuditEntity } from '../domain/enums';
import { Permission } from '../domain/permissions';
import { IN_WORK_STATUSES, canTransition } from '../domain/ticket-transitions';
import { CommentRepository } from '../repositories/comment.repository';
import { TicketHistoryRepository } from '../repositories/ticket-history.repository';
import { TicketRepository, type TicketListFilter, type TicketWithRelations } from '../repositories/ticket.repository';
import { UserRepository } from '../repositories/user.repository';
import { commentSchema, parseInput } from '../security/input';
import type { QueueKind } from '../security/callback-data';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { inTransaction } from '../utils/prisma';
import type { AuditService } from './audit.service';
import type { NotificationService } from './notification.service';
import type { PermissionService } from './permission.service';
import type { Page } from './ticket.service';

export interface HistoryEntry {
  at: Date;
  text: string;
}

export class AdminTicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tickets: TicketRepository,
    private readonly users: UserRepository,
    private readonly history: TicketHistoryRepository,
    private readonly comments: CommentRepository,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly notifications: NotificationService,
    private readonly log: Logger,
  ) {}

  async queue(admin: User, kind: QueueKind, page: number): Promise<Page<TicketWithRelations>> {
    await this.permissions.require(admin, Permission.ViewQueue);
    const filters: Record<QueueKind, TicketListFilter> = {
      new: { statuses: [TicketStatus.NEW] },
      prog: { statuses: IN_WORK_STATUSES },
      mine: { assignedAdminId: admin.id, statuses: [...IN_WORK_STATUSES, TicketStatus.RESOLVED] },
      all: {},
    };
    const { items, total } = await this.tickets.list(this.prisma, filters[kind], page * LIMITS.PAGE_SIZE, LIMITS.PAGE_SIZE);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / LIMITS.PAGE_SIZE)) };
  }

  async find(admin: User, number: number): Promise<TicketWithRelations> {
    await this.permissions.require(admin, Permission.ViewAnyTicket);
    const ticket = await this.tickets.findByNumber(this.prisma, number);
    if (!ticket) throw new NotFoundError(`ticket ${number}`);
    return ticket;
  }

  /** Исполнитель заявки или superadmin. */
  private async requireManage(admin: User, ticket: TicketWithRelations): Promise<void> {
    if (ticket.assignedAdminId === admin.id || (admin.role === Role.SUPERADMIN && admin.isActive)) return;
    await this.audit.recordStandalone({
      actorId: admin.id,
      action: AuditAction.AccessDenied,
      entityType: AuditEntity.Ticket,
      entityId: ticket.id,
      metadata: { reason: 'not_assignee' },
    });
    throw new ForbiddenError(`admin ${admin.id} is not assignee of ticket ${ticket.id}`);
  }

  /**
   * Конкурентное принятие. Условный UPDATE в одной транзакции с историей и аудитом:
   * побеждает ровно один администратор, остальные получают ConflictError.
   */
  async accept(admin: User, number: number): Promise<TicketWithRelations> {
    await this.permissions.require(admin, Permission.AcceptTicket);
    const ticket = await this.find(admin, number);

    await inTransaction(this.prisma, async (tx) => {
      const won = await this.tickets.acceptIfFree(tx, ticket.id, admin.id);
      if (!won) throw new ConflictError('Заявку уже приняли в работу.');
      await this.history.add(tx, ticket.id, TicketStatus.NEW, TicketStatus.IN_PROGRESS, admin.id);
      await this.audit.record(tx, {
        actorId: admin.id,
        action: AuditAction.TicketAccepted,
        entityType: AuditEntity.Ticket,
        entityId: ticket.id,
        metadata: { number },
      });
    });
    this.log.info({ ticketId: ticket.id, number, adminId: admin.id }, 'ticket accepted');
    const fresh = await this.find(admin, number);
    await this.notifications.notifyUserStatus(fresh, TicketStatus.IN_PROGRESS);
    return fresh;
  }

  async changeStatus(admin: User, number: number, to: TicketStatus): Promise<TicketWithRelations> {
    await this.permissions.require(admin, Permission.ChangeStatus);
    const ticket = await this.find(admin, number);
    await this.requireManage(admin, ticket);
    if (!canTransition(ticket.status, to)) throw new ConflictError('Такой переход статуса недопустим.');

    await inTransaction(this.prisma, async (tx) => {
      const changed = await this.tickets.changeStatusIf(tx, ticket.id, ticket.status, to);
      if (!changed) throw new ConflictError('Статус заявки уже изменился. Обновите карточку.');
      await this.history.add(tx, ticket.id, ticket.status, to, admin.id);
      await this.audit.record(tx, {
        actorId: admin.id,
        action: AuditAction.TicketStatusChanged,
        entityType: AuditEntity.Ticket,
        entityId: ticket.id,
        metadata: { from: ticket.status, to },
      });
      if (to === TicketStatus.CLOSED) {
        await this.audit.record(tx, {
          actorId: admin.id,
          action: AuditAction.TicketClosed,
          entityType: AuditEntity.Ticket,
          entityId: ticket.id,
        });
      }
    });
    this.log.info({ ticketId: ticket.id, number, adminId: admin.id, from: ticket.status, to }, 'ticket status changed');
    const fresh = await this.find(admin, number);
    await this.notifications.notifyUserStatus(fresh, to);
    return fresh;
  }

  async addComment(admin: User, number: number, rawText: string, visibility: CommentVisibility): Promise<TicketWithRelations> {
    await this.permissions.require(admin, Permission.CommentTicket);
    const text = parseInput(commentSchema, rawText);
    if (!text.ok) throw new ValidationError(text.error);
    const ticket = await this.find(admin, number);

    await inTransaction(this.prisma, async (tx) => {
      await this.comments.add(tx, ticket.id, admin.id, text.value, visibility);
      await this.audit.record(tx, {
        actorId: admin.id,
        action: AuditAction.TicketCommentCreated,
        entityType: AuditEntity.Ticket,
        entityId: ticket.id,
        metadata: { visibility },
      });
    });
    if (visibility === CommentVisibility.USER) await this.notifications.notifyUserComment(ticket, admin, text.value);
    return ticket;
  }

  async transfer(admin: User, number: number, toAdminId: number): Promise<TicketWithRelations> {
    await this.permissions.require(admin, Permission.TransferTicket);
    const ticket = await this.find(admin, number);
    await this.requireManage(admin, ticket);
    if (toAdminId === ticket.assignedAdminId) throw new ConflictError('Заявка уже назначена на этого администратора.');
    const target = await this.users.findById(this.prisma, toAdminId);
    if (!target || !target.isActive || (target.role !== Role.ADMIN && target.role !== Role.SUPERADMIN)) {
      throw new ValidationError('Администратор недоступен.');
    }

    await inTransaction(this.prisma, async (tx) => {
      const moved = await this.tickets.reassignIf(tx, ticket.id, ticket.assignedAdminId, target.id);
      if (!moved) throw new ConflictError('Заявка изменилась. Обновите карточку.');
      await this.audit.record(tx, {
        actorId: admin.id,
        action: AuditAction.TicketTransferred,
        entityType: AuditEntity.Ticket,
        entityId: ticket.id,
        metadata: { fromAdminId: ticket.assignedAdminId, toAdminId: target.id, toName: target.displayName },
      });
    });
    const fresh = await this.find(admin, number);
    await this.notifications.notifyTransfer(fresh, target, admin);
    return fresh;
  }

  /** История: смены статусов, передачи и комментарии в хронологическом порядке. */
  async historyOf(admin: User, number: number): Promise<HistoryEntry[]> {
    const ticket = await this.find(admin, number);
    const [statuses, transfers, comments] = await Promise.all([
      this.history.list(this.prisma, ticket.id),
      this.audit.listForEntity(AuditEntity.Ticket, ticket.id, [AuditAction.TicketTransferred]),
      this.comments.list(this.prisma, ticket.id, [CommentVisibility.INTERNAL, CommentVisibility.USER]),
    ]);
    const entries: HistoryEntry[] = [
      ...statuses.map((h) => ({
        at: h.createdAt,
        text: h.oldStatus ? `${h.oldStatus} → ${h.newStatus} (${h.changer.displayName})` : `создана (${h.changer.displayName})`,
      })),
      ...transfers.map((a) => {
        const meta = (a.metadata ?? {}) as { toName?: string };
        return { at: a.createdAt, text: `передана → ${meta.toName ?? '?'} (${a.actor?.displayName ?? 'система'})` };
      }),
      ...comments.map((c) => ({
        at: c.createdAt,
        text: `комментарий [${c.visibility === CommentVisibility.INTERNAL ? 'внутр.' : 'польз.'}] ${c.author.displayName}: ${c.text}`,
      })),
    ];
    return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  }
}
