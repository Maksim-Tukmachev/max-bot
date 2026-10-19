import type { PrismaClient } from '@prisma/client';
import { LIMITS } from '../config/constants';
import { WebhookRepository } from '../repositories/webhook.repository';

export class WebhookDedupeService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: WebhookRepository,
  ) {}

  /** true — событие новое и должно быть обработано; false — дубль. */
  claim(eventId: string): Promise<boolean> {
    return this.repo.markProcessed(this.prisma, eventId);
  }

  /** Если обработка упала до результата, снимаем отметку — повторная доставка MAX обработается. */
  release(eventId: string): Promise<void> {
    return this.repo.unmark(this.prisma, eventId);
  }

  cleanup(): Promise<number> {
    return this.repo.deleteOlderThan(this.prisma, new Date(Date.now() - LIMITS.WEBHOOK_RETENTION_DAYS * 86_400_000));
  }
}
