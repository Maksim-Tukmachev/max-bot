import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export function createPrisma(): PrismaClient {
  return new PrismaClient({ log: [{ emit: 'stdout', level: 'error' }] });
}

/** PostgreSQL transaction isolation: READ COMMITTED по умолчанию достаточно — гонки закрыты условным UPDATE. */
export async function inTransaction<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { timeout: 10_000 });
}
