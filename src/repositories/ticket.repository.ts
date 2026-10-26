import { Prisma, TicketStatus } from '@prisma/client';
import type { Db } from '../utils/prisma';

export const ticketInclude = {
  branch: true,
  user: true,
  assignedAdmin: true,
  _count: { select: { attachments: true } },
} satisfies Prisma.TicketInclude;

export type TicketWithRelations = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;

export interface TicketListFilter {
  statuses?: readonly TicketStatus[];
  userId?: number;
  assignedAdminId?: number;
}

/** Prisma `contains` не экранирует % и _ — делаем это сами, чтобы поиск был буквальным. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

export interface ArchiveFilter {
  since: Date | null;
  branchId: number | null;
  query: string | null;
}

export interface PhotoData {
  token: string;
  photoId?: number;
}

export interface CreateTicketData {
  userId: number;
  branchId: number;
  room: string;
  description: string;
}

export class TicketRepository {
  create(db: Db, data: CreateTicketData): Promise<TicketWithRelations> {
    return db.ticket.create({ data, include: ticketInclude });
  }

  /** Закрытые заявки по убыванию даты закрытия. Поиск — параметризованный ILIKE (Prisma экранирует % и _). */
  async listArchive(db: Db, filter: ArchiveFilter, skip: number, take: number): Promise<{ items: TicketWithRelations[]; total: number }> {
    const where: Prisma.TicketWhereInput = {
      status: TicketStatus.CLOSED,
      ...(filter.since ? { closedAt: { gte: filter.since } } : {}),
      ...(filter.branchId !== null ? { branchId: filter.branchId } : {}),
      ...(filter.query
        ? {
            OR: [
              { description: { contains: escapeLike(filter.query), mode: 'insensitive' } },
              { room: { contains: escapeLike(filter.query), mode: 'insensitive' } },
              { user: { displayName: { contains: escapeLike(filter.query), mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      db.ticket.findMany({ where, include: ticketInclude, orderBy: [{ closedAt: 'desc' }, { id: 'desc' }], skip, take }),
      db.ticket.count({ where }),
    ]);
    return { items, total };
  }

  async addAttachments(db: Db, ticketId: number, uploadedById: number, photos: readonly PhotoData[]): Promise<void> {
    if (photos.length === 0) return;
    await db.ticketAttachment.createMany({
      data: photos.map((p) => ({ ticketId, uploadedById, token: p.token, photoId: p.photoId ?? null })),
    });
  }

  async attachmentTokens(db: Db, ticketId: number): Promise<string[]> {
    const rows = await db.ticketAttachment.findMany({ where: { ticketId }, orderBy: { id: 'asc' }, select: { token: true } });
    return rows.map((r) => r.token);
  }

  countCreatedSince(db: Db, userId: number, since: Date): Promise<number> {
    return db.ticket.count({ where: { userId, createdAt: { gte: since } } });
  }

  findByNumber(db: Db, number: number): Promise<TicketWithRelations | null> {
    return db.ticket.findUnique({ where: { number }, include: ticketInclude });
  }

  private where(filter: TicketListFilter): Prisma.TicketWhereInput {
    return {
      ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
      ...(filter.userId !== undefined ? { userId: filter.userId } : {}),
      ...(filter.assignedAdminId !== undefined ? { assignedAdminId: filter.assignedAdminId } : {}),
    };
  }

  async list(db: Db, filter: TicketListFilter, skip: number, take: number): Promise<{ items: TicketWithRelations[]; total: number }> {
    const where = this.where(filter);
    const [items, total] = await Promise.all([
      db.ticket.findMany({ where, include: ticketInclude, orderBy: { number: 'desc' }, skip, take }),
      db.ticket.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Атомарное принятие: условный UPDATE выполняется PostgreSQL под блокировкой строки,
   * поэтому из нескольких одновременных запросов успешным будет ровно один (count = 1).
   */
  async acceptIfFree(db: Db, ticketId: number, adminId: number): Promise<boolean> {
    const result = await db.ticket.updateMany({
      where: { id: ticketId, status: TicketStatus.NEW, assignedAdminId: null },
      data: { status: TicketStatus.IN_PROGRESS, assignedAdminId: adminId, acceptedAt: new Date() },
    });
    return result.count === 1;
  }

  /** Смена статуса с проверкой ожидаемого старого значения (защита от гонок). */
  async changeStatusIf(db: Db, ticketId: number, from: TicketStatus, to: TicketStatus): Promise<boolean> {
    const now = new Date();
    const result = await db.ticket.updateMany({
      where: { id: ticketId, status: from },
      data: {
        status: to,
        ...(to === TicketStatus.RESOLVED ? { resolvedAt: now } : {}),
        ...(to === TicketStatus.CLOSED ? { closedAt: now, resolvedAt: now } : {}),
        ...(to === TicketStatus.IN_PROGRESS ? { closedAt: null } : {}),
      },
    });
    return result.count === 1;
  }

  async reassignIf(db: Db, ticketId: number, fromAdminId: number | null, toAdminId: number): Promise<boolean> {
    const result = await db.ticket.updateMany({
      where: { id: ticketId, assignedAdminId: fromAdminId, status: { notIn: [TicketStatus.NEW, TicketStatus.CLOSED] } },
      data: { assignedAdminId: toAdminId },
    });
    return result.count === 1;
  }
}
