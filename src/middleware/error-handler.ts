import type { FastifyError, FastifyInstance } from 'fastify';
import type { Logger } from '../utils/logger';

/** Подробности ошибок — только в лог; клиенту HTTP — общий ответ. */
export function registerErrorHandler(app: FastifyInstance, log: Logger): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    log.error({ err, url: req.url }, 'http error');
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(status).send({ status: 'error' });
  });
  // Не найденные маршруты тоже под rate limit (@fastify/rate-limit их по умолчанию не охватывает).
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_req, reply) => {
    reply.code(404).send({ status: 'not_found' });
  });
}
