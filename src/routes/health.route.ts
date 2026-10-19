import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

export function registerHealthRoute(app: FastifyInstance, prisma: PrismaClient): void {
  app.get('/health', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error' });
    }
  });
}
