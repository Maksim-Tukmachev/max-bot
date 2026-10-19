import type { Db } from '../utils/prisma';

export class WebhookRepository {
  /** @returns true, если событие новое; false — уже обработано (дубль). */
  async markProcessed(db: Db, externalEventId: string): Promise<boolean> {
    const inserted = await db.$executeRaw`
      INSERT INTO "ProcessedWebhook" ("externalEventId") VALUES (${externalEventId})
      ON CONFLICT ("externalEventId") DO NOTHING`;
    return inserted === 1;
  }

  async deleteOlderThan(db: Db, date: Date): Promise<number> {
    const res = await db.processedWebhook.deleteMany({ where: { createdAt: { lt: date } } });
    return res.count;
  }

  async unmark(db: Db, externalEventId: string): Promise<void> {
    await db.processedWebhook.deleteMany({ where: { externalEventId } });
  }
}
