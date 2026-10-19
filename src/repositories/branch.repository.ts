import type { Branch } from '@prisma/client';
import type { Db } from '../utils/prisma';

export class BranchRepository {
  listActive(db: Db): Promise<Branch[]> {
    return db.branch.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  }

  findActiveById(db: Db, id: number): Promise<Branch | null> {
    return db.branch.findFirst({ where: { id, isActive: true } });
  }
}
