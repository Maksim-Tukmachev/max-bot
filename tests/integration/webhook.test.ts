import { Api, Webhook } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { WEBHOOK_PATH } from '../../src/config/constants';
import { logger } from '../../src/utils/logger';

const SECRET = 'test_secret_12345';

describe('POST /webhook/max и /health', () => {
  const received: unknown[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const hook = new Webhook(new Api({ call: async () => ({ status: 200, data: {} }) }), [], 'token-token-token', {
      domain: 'example.test',
      path: WEBHOOK_PATH,
      secret: SECRET,
    });
    const callback = hook.createCallback(async (u) => {
      received.push(u);
    });
    // Prisma не подключается: /health в этом тесте проверяет только ответ 503 при недоступной БД.
    const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://x:y@127.0.0.1:1/none' } } });
    app = await buildApp({ prisma, log: logger.child({}, { level: 'silent' }), webhookCallback: callback });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('отвергает запрос без секрета или с неверным секретом', async () => {
    const body = JSON.stringify({ update_type: 'bot_started', timestamp: 1 });
    for (const headers of [{}, { 'x-max-bot-api-secret': 'wrong_secret_value' }] as Record<string, string>[]) {
      const res = await app.inject({ method: 'POST', url: WEBHOOK_PATH, headers: { 'content-type': 'application/json', ...headers }, payload: body });
      expect(res.statusCode).toBe(404);
    }
    expect(received).toHaveLength(0);
  });

  it('принимает запрос с верным секретом и передаёт Update в обработчик', async () => {
    const update = { update_type: 'bot_started', timestamp: 42, chat_id: 1, user: { user_id: 5 } };
    const res = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': SECRET },
      payload: JSON.stringify(update),
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([update]);
  });

  it('другие маршруты возвращают 404, /health без БД — 503 без деталей', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin' })).statusCode).toBe(404);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ status: 'error' });
  });
});
