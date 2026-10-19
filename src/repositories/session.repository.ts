import { Prisma, SessionState, type UserSession } from '@prisma/client';
import type { Db } from '../utils/prisma';

export class SessionRepository {
  find(db: Db, userId: number): Promise<UserSession | null> {
    return db.userSession.findUnique({ where: { userId } });
  }

  set(db: Db, userId: number, state: SessionState, draft: Prisma.InputJsonValue | null): Promise<UserSession> {
    const draftValue = draft === null ? Prisma.JsonNull : draft;
    return db.userSession.upsert({
      where: { userId },
      create: { userId, state, draft: draftValue },
      update: { state, draft: draftValue },
    });
  }

  /** Атомарно «забирает» подтверждённый черновик: из параллельных вызовов успешен ровно один. */
  async claimConfirm(db: Db, userId: number): Promise<boolean> {
    const res = await db.userSession.updateMany({
      where: { userId, state: SessionState.CONFIRM },
      data: { state: SessionState.IDLE, draft: Prisma.JsonNull },
    });
    return res.count === 1;
  }

  reset(db: Db, userId: number): Promise<UserSession> {
    return this.set(db, userId, SessionState.IDLE, null);
  }
}
