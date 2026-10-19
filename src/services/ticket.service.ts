import { CommentVisibility, TicketStatus, type PrismaClient, type User } from '@prisma/client';
import { LIMITS } from '../config/constants';
import { AuditAction, AuditEntity } from '../domain/enums';
import { Permission } from '../domain/permissions';
import { ACTIVE_STATUSES, CLOSED_STATUSES } from '../domain/ticket-transitions';
import { BranchRepository } from '../repositories/branch.repository';
import { CommentRepository } from '../repositories/comment.repository';
import { TicketHistoryRepository } from '../repositories/ticket-history.repository';
import { TicketRepository, type PhotoData, type TicketWithRelations } from '../repositories/ticket.repository';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { inTransaction } from '../utils/prisma';
import { commentSchema, descriptionSchema, parseInput, roomSchema } from '../security/input';
import type { AuditService } from './audit.service';
import type { NotificationService } from './notification.service';
import type { PermissionService } from './permission.service';
import type { Logger } from '../utils/logger';

export interface TicketDraft {
  branchId: number;
  room: string;
  description: string;
  photos?: readonly PhotoData[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

export type UserListKind = 'active' | 'closed';

export class TicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tickets: TicketRepository,
    private readonly branches: BranchRepository,
    private readonly history: TicketHistoryRepository,
    private readonly comments: CommentRepository,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly notifications: NotificationService,
    private readonly log: Logger,
  ) {}

  async create(user: User, draft: TicketDraft): Promise<TicketWithRelations> {
    await this.permissions.require(user, Permission.CreateTicket);
    const room = parseInput(roomSchema, draft.room);
    const description = parseInput(descriptionSchema, draft.description);
    if (!room.ok) throw new ValidationError(room.error);
    if (!description.ok) throw new ValidationError(description.error);
    const branch = await this.branches.findActiveById(this.prisma, draft.branchId);
    if (!branch) throw new ValidationError('Выбранный филиал недоступен.');
    const photos = (draft.photos ?? []).slice(0, LIMITS.MAX_PHOTOS);
    const ticket = await inTransaction(this.prisma, async (tx) => {
      // Блокировка на пользователя: проверка лимита и создание атомарны даже при параллельных запросах.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${user.id})`;
      // Защита администраторов от спама уведомлениями.
      const since = new Date(Date.now() - LIMITS.TICKETS_WINDOW_MINUTES * 60_000);
      if ((await this.tickets.countCreatedSince(tx, user.id, since)) >= LIMITS.TICKETS_PER_WINDOW) {
        throw new ValidationError('Слишком много заявок за короткое время. Попробуйте позже.');
      }
      const created = await this.tickets.create(tx, {
        userId: user.id,
        branchId: branch.id,
        room: room.value,
        description: description.value,
      });
      await this.tickets.addAttachments(tx, created.id, user.id, photos);
      await this.history.add(tx, created.id, null, TicketStatus.NEW, user.id);
      await this.audit.record(tx, {
        actorId: user.id,
        action: AuditAction.TicketCreated,
        entityType: AuditEntity.Ticket,
        entityId: created.id,
        metadata: { number: created.number, branchId: branch.id, photos: photos.length },
      });
      return created;
    });
    this.log.info({ ticketId: ticket.id, number: ticket.number }, 'ticket created');
    const fresh = (await this.tickets.findByNumber(this.prisma, ticket.number)) ?? ticket;
    await this.notifications.notifyAdminsNewTicket(fresh);
    return fresh;
  }

  async listForUser(user: User, kind: UserListKind, page: number): Promise<Page<TicketWithRelations>> {
    const statuses = kind === 'active' ? ACTIVE_STATUSES : CLOSED_STATUSES;
    const { items, total } = await this.tickets.list(
      this.prisma,
      { userId: user.id, statuses },
      page * LIMITS.PAGE_SIZE,
      LIMITS.PAGE_SIZE,
    );
    return { items, total, page, pages: Math.max(1, Math.ceil(total / LIMITS.PAGE_SIZE)) };
  }

  /**
   * Карточка для просмотра. Чужая заявка недоступна обычному пользователю:
   * ответ неотличим от «не найдена», попытка пишется в аудит.
   */
  async getForViewer(viewer: User, number: number): Promise<TicketWithRelations> {
    const ticket = await this.tickets.findByNumber(this.prisma, number);
    if (!ticket) throw new NotFoundError(`ticket ${number}`);
    const isOwner = ticket.userId === viewer.id;
    if (!isOwner && !this.permissions.can(viewer, Permission.ViewAnyTicket)) {
      await this.audit.recordStandalone({
        actorId: viewer.id,
        action: AuditAction.AccessDenied,
        entityType: AuditEntity.Ticket,
        entityId: ticket.id,
        metadata: { number },
      });
      throw new NotFoundError(`ticket ${number} not visible to user ${viewer.id}`);
    }
    return ticket;
  }

  /** Фото заявки: доступ по тем же правилам, что и к карточке (владелец или админ). */
  async photosFor(viewer: User, number: number): Promise<string[]> {
    const ticket = await this.getForViewer(viewer, number);
    return this.tickets.attachmentTokens(this.prisma, ticket.id);
  }

  /** Пользователь видит только комментарии с visibility=USER. */
  userVisibleComments(ticketId: number) {
    return this.comments.list(this.prisma, ticketId, [CommentVisibility.USER]);
  }

  /** Ответ автора на запрос администратора (статус WAITING_USER → IN_PROGRESS). */
  async userReply(user: User, number: number, rawText: string): Promise<TicketWithRelations> {
    const text = parseInput(commentSchema, rawText);
    if (!text.ok) throw new ValidationError(text.error);
    const ticket = await this.getForViewer(user, number);
    if (ticket.userId !== user.id) throw new NotFoundError(`ticket ${number}`);
    if (ticket.status !== TicketStatus.WAITING_USER) throw new ConflictError('Сейчас по заявке не требуется ответ.');

    await inTransaction(this.prisma, async (tx) => {
      const moved = await this.tickets.changeStatusIf(tx, ticket.id, TicketStatus.WAITING_USER, TicketStatus.IN_PROGRESS);
      if (!moved) throw new ConflictError('Статус заявки уже изменился.');
      await this.history.add(tx, ticket.id, TicketStatus.WAITING_USER, TicketStatus.IN_PROGRESS, user.id);
      await this.comments.add(tx, ticket.id, user.id, text.value, CommentVisibility.USER);
      await this.audit.record(tx, {
        actorId: user.id,
        action: AuditAction.TicketCommentCreated,
        entityType: AuditEntity.Ticket,
        entityId: ticket.id,
        metadata: { visibility: CommentVisibility.USER, byAuthor: true },
      });
    });
    const fresh = await this.getForViewer(user, number);
    await this.notifications.notifyAssigneeUserReply(fresh, text.value);
    return fresh;
  }
}
