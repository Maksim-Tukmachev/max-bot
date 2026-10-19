import type { Prisma } from '@prisma/client';
import type { Db } from '../utils/prisma';

export interface AuditEntry {
  actorId: number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

export class AuditRepository {
  add(db: Db, entry: AuditEntry) {
    return db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
        metadata: entry.metadata ?? undefined,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }

  listForEntity(db: Db, entityType: string, entityId: string | number, actions: readonly string[]) {
    return db.auditLog.findMany({
      where: { entityType, entityId: String(entityId), action: { in: [...actions] } },
      include: { actor: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
