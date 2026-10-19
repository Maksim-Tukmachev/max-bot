import type { TicketStatus } from '@prisma/client';
import type { Db } from '../utils/prisma';

export class TicketHistoryRepository {
  add(db: Db, ticketId: number, oldStatus: TicketStatus | null, newStatus: TicketStatus, changedBy: number) {
    return db.ticketStatusHistory.create({ data: { ticketId, oldStatus, newStatus, changedBy } });
  }

  list(db: Db, ticketId: number) {
    return db.ticketStatusHistory.findMany({
      where: { ticketId },
      include: { changer: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
