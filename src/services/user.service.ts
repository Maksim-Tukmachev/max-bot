import { Role, type PrismaClient, type User } from '@prisma/client';
import { AuditAction, AuditEntity } from '../domain/enums';
import { Permission } from '../domain/permissions';
import { UserRepository } from '../repositories/user.repository';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { LIMITS } from '../config/constants';
import { normalizeText, truncate } from '../utils/text';
import type { AuditService } from './audit.service';
import type { PermissionService } from './permission.service';

export class UserService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  /** Роль всегда берётся из БД по MAX user_id — из входящих данных она не читается. */
  touch(maxUserId: bigint, displayName: string): Promise<User> {
    const name = truncate(normalizeText(displayName) || 'Без имени', LIMITS.DISPLAY_NAME_MAX);
    return this.users.upsertSeen(this.prisma, maxUserId, name);
  }

  /** Единственный способ получить роль SUPERADMIN: идентификатор из окружения при старте. */
  async ensureSuperadmin(maxUserId: bigint): Promise<User> {
    const existing = await this.users.findByMaxId(this.prisma, maxUserId);
    const user = existing
      ? existing.role === Role.SUPERADMIN && existing.isActive
        ? existing
        : await this.prisma.user.update({ where: { id: existing.id }, data: { role: Role.SUPERADMIN, isActive: true } })
      : await this.prisma.user.create({ data: { maxUserId, displayName: 'Superadmin', role: Role.SUPERADMIN } });
    if (!existing || existing.role !== Role.SUPERADMIN) {
      await this.audit.recordStandalone({
        actorId: null,
        action: AuditAction.AdminCreated,
        entityType: AuditEntity.User,
        entityId: user.id,
        metadata: { role: Role.SUPERADMIN, source: 'env' },
      });
    }
    return user;
  }

  listActiveAdmins(): Promise<User[]> {
    return this.users.listActiveAdmins(this.prisma);
  }

  async listAdmins(actor: User): Promise<User[]> {
    await this.permissions.require(actor, Permission.ManageAdmins);
    return this.users.listAdmins(this.prisma);
  }

  async disableAdmin(actor: User, adminId: number): Promise<User> {
    await this.permissions.require(actor, Permission.ManageAdmins);
    const target = await this.users.findById(this.prisma, adminId);
    if (!target || target.role === Role.USER) throw new NotFoundError(`admin ${adminId}`);
    if (target.role === Role.SUPERADMIN) throw new ForbiddenError('cannot disable superadmin');
    // Снимаем только админскую роль: как обычный сотрудник человек продолжает пользоваться ботом.
    const updated = await this.prisma.user.update({ where: { id: target.id }, data: { role: Role.USER } });
    await this.audit.recordStandalone({
      actorId: actor.id,
      action: AuditAction.AdminDisabled,
      entityType: AuditEntity.User,
      entityId: target.id,
    });
    return updated;
  }
}
