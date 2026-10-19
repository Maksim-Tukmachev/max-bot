import type { CommentVisibility } from '@prisma/client';
import type { Db } from '../utils/prisma';

export class CommentRepository {
  add(db: Db, ticketId: number, authorId: number, text: string, visibility: CommentVisibility) {
    return db.ticketComment.create({ data: { ticketId, authorId, text, visibility } });
  }

  list(db: Db, ticketId: number, visibilities: readonly CommentVisibility[]) {
    return db.ticketComment.findMany({
      where: { ticketId, visibility: { in: [...visibilities] } },
      include: { author: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
