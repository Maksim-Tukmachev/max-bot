import type { User } from '@prisma/client';
import { AuditAction, AuditEntity } from '../domain/enums';
import { Permission, roleHasPermission } from '../domain/permissions';
import { ForbiddenError } from '../utils/errors';
import type { AuditService } from './audit.service';

export class PermissionService {
  constructor(private readonly audit: AuditService) {}

  can(user: User, permission: Permission): boolean {
    return user.isActive && roleHasPermission(user.role, permission);
  }

  /** Проверка при каждой защищённой операции. Отказ фиксируется в аудите независимо от результата операции. */
  async require(user: User, permission: Permission, context?: Record<string, string | number>): Promise<void> {
    if (this.can(user, permission)) return;
    await this.audit.recordStandalone({
      actorId: user.id,
      action: AuditAction.AccessDenied,
      entityType: AuditEntity.User,
      entityId: user.id,
      metadata: { permission, ...context },
    });
    throw new ForbiddenError(`user ${user.id} lacks ${permission}`);
  }
}
