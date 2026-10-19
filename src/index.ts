import { Bot } from '@maxhub/max-bot-api';
import { buildApp } from './app';
import { MaxMode, SHUTDOWN_TIMEOUT_MS, WEBHOOK_PATH } from './config/constants';
import { loadEnv } from './config/env';
import { buildContainer, wireBot } from './container';
import { MaxMessenger } from './bot/max-messenger';
import { logger } from './utils/logger';
import { createPrisma } from './utils/prisma';

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrisma();
  await prisma.$connect();

  const bot = new Bot(env.MAX_BOT_TOKEN);
  const messenger = new MaxMessenger(bot.api, logger);
  const container = buildContainer(prisma, messenger, logger);
  wireBot(bot, container, logger);
  bot.catch((err) => logger.error({ err }, 'bot middleware error'));

  if (env.SUPERADMIN_MAX_USER_ID) {
    const su = await container.users.ensureSuperadmin(BigInt(env.SUPERADMIN_MAX_USER_ID));
    logger.info({ userId: su.id }, 'superadmin ensured');
  } else {
    logger.warn('SUPERADMIN_MAX_USER_ID не задан: superadmin не назначен');
  }

  const webhookCallback =
    env.MAX_MODE === MaxMode.Webhook
      ? await bot.createWebhook({
          domain: env.MAX_WEBHOOK_DOMAIN ?? '',
          path: WEBHOOK_PATH,
          secret: env.MAX_WEBHOOK_SECRET,
          allowedUpdates: ['bot_started', 'message_created', 'message_callback'],
        })
      : undefined;

  const app = await buildApp({ prisma, log: logger, webhookCallback });
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  logger.info({ port: env.PORT, mode: env.MAX_MODE }, 'http server started');

  if (env.MAX_MODE === MaxMode.Polling) {
    // start() сам снимает webhook-подписки и запускает long polling.
    void bot
      .start({ mode: 'polling', options: { allowedUpdates: ['bot_started', 'message_created', 'message_callback'] } })
      .catch((err: unknown) => logger.fatal({ err }, 'polling failed'));
  }

  const maintenance = setInterval(() => {
    container.limiter.prune();
    container.dedupe.cleanup().catch((err: unknown) => logger.error({ err }, 'webhook cleanup failed'));
  }, 3_600_000);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started');
    const force = setTimeout(() => {
      logger.error('shutdown timeout, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      clearInterval(maintenance);
      bot.stopPolling();
      await app.close(); // перестаёт принимать новые запросы и ждёт активные
      await prisma.$disconnect();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
