import { createHash, randomInt } from 'node:crypto';
import { Role, type PrismaClient, type User } from '@prisma/client';
import { LIMITS } from '../config/constants';
import { AuditAction, AuditEntity } from '../domain/enums';
import { Permission } from '../domain/permissions';
import { ActivationCodeRepository } from '../repositories/activation-code.repository';
import { ConflictError } from '../utils/errors';
import { inTransaction } from '../utils/prisma';
import type { AuditService } from './audit.service';
import type { PermissionService } from './permission.service';

// Без похожих символов (0/O, 1/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const hashCode = (code: string): string => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

export class ActivationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly codes: ActivationCodeRepository,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  /** Создать одноразовый код для нового администратора (только superadmin). Код показывается один раз. */
  async createCode(actor: User): Promise<{ code: string; expiresAt: Date }> {
    await this.permissions.require(actor, Permission.ManageAdmins);
    const code = Array.from({ length: LIMITS.ACTIVATION_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expiresAt = new Date(Date.now() + LIMITS.ACTIVATION_CODE_TTL_HOURS * 3_600_000);
    await this.codes.create(this.prisma, hashCode(code), actor.id, expiresAt);
    await this.audit.recordStandalone({
      actorId: actor.id,
      action: AuditAction.ActivationCodeCreated,
      entityType: AuditEntity.ActivationCode,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
    return { code, expiresAt };
  }

  /** Активация: пользователь становится ADMIN. Код сгорает атомарно. Superadmin сюда не попадает. */
  async activate(user: User, rawCode: string): Promise<User> {
    const now = new Date();
    const result = await inTransaction(this.prisma, async (tx) => {
      const ok = await this.codes.consume(tx, hashCode(rawCode), user.id, now);
      if (!ok) return null;
      const updated =
        user.role === Role.SUPERADMIN
          ? user
          : await tx.user.update({ where: { id: user.id }, data: { role: Role.ADMIN, isActive: true } });
      await this.audit.record(tx, {
        actorId: user.id,
        action: AuditAction.AdminActivated,
        entityType: AuditEntity.User,
        entityId: user.id,
      });
      return updated;
    });
    if (!result) {
      await this.audit.recordStandalone({
        actorId: user.id,
        action: AuditAction.AccessDenied,
        entityType: AuditEntity.ActivationCode,
        metadata: { reason: 'invalid_or_expired_code' },
      });
      throw new ConflictError('Код недействителен или истёк.');
    }
    return result;
  }
}
