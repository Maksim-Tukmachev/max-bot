import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import { registerErrorHandler } from './middleware/error-handler';
import { registerHealthRoute } from './routes/health.route';
import { registerWebhookRoute, type WebhookCallback } from './routes/webhook.route';
import type { Logger } from './utils/logger';

export interface AppOptions {
  prisma: PrismaClient;
  log: Logger;
  webhookCallback?: WebhookCallback;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: opts.log as unknown as FastifyBaseLogger,
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  registerErrorHandler(app, opts.log);
  registerHealthRoute(app, opts.prisma);
  if (opts.webhookCallback) registerWebhookRoute(app, opts.webhookCallback);
  return app;
}
