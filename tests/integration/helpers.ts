import { PrismaClient, Role, type User } from '@prisma/client';
import { buildContainer, type Container } from '../../src/container';
import type { Messenger, Screen } from '../../src/types/messenger';
import { logger } from '../../src/utils/logger';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

export class FakeMessenger implements Messenger {
  sent: { to: bigint; screen: Screen }[] = [];
  async sendToUser(to: bigint, screen: Screen): Promise<boolean> {
    this.sent.push({ to, screen });
    return true;
  }
  textsTo(maxUserId: bigint): string[] {
    return this.sent.filter((m) => m.to === maxUserId).map((m) => m.screen.text);
  }
}

export interface TestEnv {
  prisma: PrismaClient;
  c: Container;
  messenger: FakeMessenger;
  branchId: number;
}

export function createPrismaForTests(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog","ProcessedWebhook","UserSession","AdminActivationCode","TicketComment","TicketStatusHistory","Ticket","Branch","User" RESTART IDENTITY CASCADE',
  );
}

export async function setup(prisma: PrismaClient): Promise<TestEnv> {
  await resetDb(prisma);
  const branch = await prisma.branch.create({ data: { name: 'Тестовый филиал' } });
  const messenger = new FakeMessenger();
  const c = buildContainer(prisma, messenger, logger.child({}, { level: 'silent' }));
  return { prisma, c, messenger, branchId: branch.id };
}

let counter = 1000;
export function makeUser(prisma: PrismaClient, role: Role = Role.USER, name = 'Тест'): Promise<User> {
  counter += 1;
  return prisma.user.create({ data: { maxUserId: BigInt(counter), displayName: `${name} ${counter}`, role } });
}
