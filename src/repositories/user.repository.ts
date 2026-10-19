import { Role, type User } from '@prisma/client';
import type { Db } from '../utils/prisma';

export class UserRepository {
  findByMaxId(db: Db, maxUserId: bigint): Promise<User | null> {
    return db.user.findUnique({ where: { maxUserId } });
  }

  findById(db: Db, id: number): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  upsertSeen(db: Db, maxUserId: bigint, displayName: string): Promise<User> {
    return db.user.upsert({
      where: { maxUserId },
      create: { maxUserId, displayName },
      update: { displayName, lastSeenAt: new Date() },
    });
  }

  setRole(db: Db, id: number, role: Role): Promise<User> {
    return db.user.update({ where: { id }, data: { role } });
  }

  setActive(db: Db, id: number, isActive: boolean): Promise<User> {
    return db.user.update({ where: { id }, data: { isActive } });
  }

  listActiveAdmins(db: Db): Promise<User[]> {
    return db.user.findMany({
      where: { isActive: true, role: { in: [Role.ADMIN, Role.SUPERADMIN] } },
      orderBy: { displayName: 'asc' },
    });
  }

  listAdmins(db: Db): Promise<User[]> {
    return db.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.SUPERADMIN] } },
      orderBy: [{ role: 'desc' }, { displayName: 'asc' }],
    });
  }
}
