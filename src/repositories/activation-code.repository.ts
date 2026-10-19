import type { Db } from '../utils/prisma';

export class ActivationCodeRepository {
  create(db: Db, codeHash: string, createdById: number | null, expiresAt: Date) {
    return db.adminActivationCode.create({ data: { codeHash, createdById, expiresAt } });
  }

  /** Атомарно «сжигает» код: успешно ровно для одного вызывающего. */
  async consume(db: Db, codeHash: string, usedById: number, now: Date): Promise<boolean> {
    const res = await db.adminActivationCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, usedById },
    });
    return res.count === 1;
  }
}
