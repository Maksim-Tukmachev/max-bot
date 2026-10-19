import type { PrismaClient } from '@prisma/client';
import type { AuditAction, AuditEntity } from '../domain/enums';
import { AuditRepository, type AuditEntry } from '../repositories/audit.repository';
import type { Logger } from '../utils/logger';
import type { Db } from '../utils/prisma';

export interface AuditInput extends Omit<AuditEntry, 'action' | 'entityType'> {
  action: AuditAction;
  entityType: AuditEntity;
}

export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: AuditRepository,
    private readonly log: Logger,
  ) {}

  /** Запись внутри переданной транзакции (атомарно с бизнес-действием). */
  record(db: Db, input: AuditInput): Promise<unknown> {
    return this.repo.add(db, input);
  }

  /** Запись вне транзакции; ошибка аудита не должна ломать основной поток, но логируется. */
  async recordStandalone(input: AuditInput): Promise<void> {
    try {
      await this.repo.add(this.prisma, input);
    } catch (err) {
      this.log.error({ err, action: input.action }, 'audit write failed');
    }
  }

  listForEntity(entityType: AuditEntity, entityId: string | number, actions: readonly AuditAction[]) {
    return this.repo.listForEntity(this.prisma, entityType, entityId, actions);
  }
}
