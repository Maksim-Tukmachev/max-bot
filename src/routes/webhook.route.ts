import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_PATH } from '../config/constants';

export type WebhookCallback = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * POST /webhook/max. Проверку секрета (X-Max-Bot-Api-Secret, constant-time), разбор JSON
 * и ответ 200 выполняет SDK; сюда же добавлен лимит запросов на уровне IP.
 */
export function registerWebhookRoute(app: FastifyInstance, callback: WebhookCallback): void {
  // Тело читает SDK из сырого потока — отключаем разбор Fastify для этого маршрута.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    scope.post(WEBHOOK_PATH, { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, (req, reply) => {
      reply.hijack();
      const raw = req.raw;
      const out = reply.raw;
      const reject = (): void => {
        if (out.headersSent) return;
        out.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
        out.end('Payload Too Large');
        raw.destroy();
      };
      // SDK читает тело сам и без лимита — ограничиваем до передачи управления.
      const declared = Number(raw.headers['content-length'] ?? 0);
      if (declared > WEBHOOK_MAX_BODY_BYTES) return reject();
      let received = 0;
      raw.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > WEBHOOK_MAX_BODY_BYTES) reject();
      });
      callback(raw, out);
    });
  });
}
