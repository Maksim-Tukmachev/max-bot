import { Api, Webhook } from '@maxhub/max-bot-api';
import { PrismaClient, Role, SessionState, TicketStatus, type User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { Responder } from '../../src/bot/types';
import { WEBHOOK_PATH } from '../../src/config/constants';
import { cb, parseCallback } from '../../src/security/callback-data';
import type { Screen } from '../../src/types/messenger';
import { logger } from '../../src/utils/logger';
import { TEST_DB_URL, createPrismaForTests, makeUser, setup, type TestEnv } from '../integration/helpers';

class Rec implements Responder {
  shown: Screen[] = [];
  notices: string[] = [];
  async show(s: Screen) { this.shown.push(s); }
  async notify(t: string) { this.notices.push(t); }
  get all(): string { return [...this.shown.map((s) => s.text), ...this.notices].join('\n'); }
}

const SQLI = [
  `'; DROP TABLE "Ticket"; --`,
  `' OR '1'='1`,
  `1; DELETE FROM "User"; --`,
  `" OR ""="`,
  `'); TRUNCATE "AuditLog" CASCADE; --`,
  `1' UNION SELECT token,1,1 FROM "TicketAttachment" --`,
  `\\'; UPDATE "User" SET role='SUPERADMIN'; --`,
  `$$; DROP SCHEMA public CASCADE; $$`,
  `Robert'); DROP TABLE Students;--`,
  `{"$ne": null}`,
  `\${7*7} {{7*7}} <script>alert(1)</script> <img src=x onerror=alert(1)>`,
  `%00 \u0000 ‮ ﻿`,
  `../../etc/passwd`,
  `a`.repeat(10_000),
];

const tableCounts = async (prisma: PrismaClient) => ({
  users: await prisma.user.count(),
  tickets: await prisma.ticket.count(),
  audit: await prisma.auditLog.count(),
  branches: await prisma.branch.count(),
});

describe.skipIf(!TEST_DB_URL)('ATTACKS (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let env: TestEnv;
  beforeAll(() => { prisma = createPrismaForTests(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { env = await setup(prisma); });

  const mkTicket = (u: User, extra = {}) => env.c.tickets.create(u, { branchId: env.branchId, room: '1', description: 'x', ...extra });
  const text = (user: User, t: string, res = new Rec()) => env.c.router.handle({ kind: 'text', user, text: t }, res).then(() => res);
  const press = (user: User, payload: string, res = new Rec()) => env.c.router.handle({ kind: 'callback', user, payload }, res).then(() => res);

  describe('SQL-инъекции и вредоносный текст', () => {
    it('payload в кабинете и описании сохраняется как обычный текст, таблицы целы', async () => {
      const user = await makeUser(prisma);
      await makeUser(prisma, Role.ADMIN);
      for (const payload of SQLI) {
        await press(user, cb.userNew);
        await press(user, cb.userBranch(env.branchId));
        const room = payload.slice(0, 100);
        await text(user, room);
        await text(user, payload);
        await press(user, cb.userSend);
        // Лимит заявок за окно не должен ломать остальные проверки: сбрасываем окно.
        await prisma.ticket.updateMany({ data: { createdAt: new Date(Date.now() - 3_600_000) } });
      }
      const before = await tableCounts(prisma);
      expect(before.users).toBeGreaterThanOrEqual(2);
      expect(before.branches).toBe(1);
      expect(await prisma.user.count({ where: { role: Role.SUPERADMIN } })).toBe(0);
      const stored = await prisma.ticket.findMany();
      expect(stored.some((t) => t.description.includes('DROP TABLE'))).toBe(true); // хранится буквально
      expect(stored.every((t) => t.description.length <= 2000 && t.room.length <= 100)).toBe(true);
      // схема на месте
      const tables = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM information_schema.tables WHERE table_schema='public'`;
      expect(Number(tables[0]?.n)).toBeGreaterThanOrEqual(10);
    });

    it('payload в комментариях, поиске, коде активации и имени пользователя', async () => {
      const root = await env.c.users.ensureSuperadmin(5550001n);
      const admin = await makeUser(prisma, Role.ADMIN);
      const user = await makeUser(prisma);
      const t = await mkTicket(user);
      await env.c.adminTickets.accept(admin, t.number);
      for (const payload of SQLI) {
        await press(admin, cb.adminCommentStart(t.number, 'user'));
        await text(admin, payload);
        await press(admin, cb.adminFind);
        await text(admin, payload);
        await text(user, `/activate ${payload}`);
        await env.c.users.touch(BigInt(Math.floor(Math.random() * 1e12)), payload);
      }
      expect(await prisma.ticket.count()).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe(Role.USER);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: root.id } })).role).toBe(Role.SUPERADMIN);
      const names = await prisma.user.findMany({ select: { displayName: true } });
      expect(names.every((n) => n.displayName.length <= 200)).toBe(true);
    });

    it('SQL-инъекция в идентификатор события webhook (ON CONFLICT DO NOTHING)', async () => {
      expect(await env.c.dedupe.claim(`msg:'; DROP TABLE "ProcessedWebhook"; --`)).toBe(true);
      expect(await env.c.dedupe.claim(`msg:'; DROP TABLE "ProcessedWebhook"; --`)).toBe(false);
      expect(await prisma.processedWebhook.count()).toBe(1);
    });

    it('нулевой байт и управляющие символы не роняют БД', async () => {
      const user = await makeUser(prisma);
      await press(user, cb.userNew);
      await press(user, cb.userBranch(env.branchId));
      const r1 = await text(user, 'каб\u0000инет\u0007 12');
      expect(r1.all).not.toContain('Что-то пошло не так');
      const r2 = await text(user, 'описание\u0000 с\u001b[31m нулём');
      expect(r2.all).toContain('Проверьте заявку');
    });
  });

  describe('Фаззинг callback-кнопок', () => {
    const garbage = [
      '', ' ', 'null', 'undefined', '{}', '[]', '__proto__', 'constructor', 'a', 'a:', ':', '::', 'a:acc:', 'a:acc:NaN', 'a:acc:Infinity',
      'a:acc:1e9', 'a:acc:0x10', 'a:acc:+5', 'a:acc: 5', 'a:acc:5 ', 'a:acc:05', 'a:acc:2147483648', 'a:acc:99999999999999999999',
      "a:acc:1';--", 'a:st:1:ip:extra', 'a:st:1:IP', 'a:cm:1:x', 'a:q:all:-1', 'a:q:all:1.5', 'a:q:ALL:0', 'u:l:x:0', 'u:l:a:99999',
      't:1:2:3', 's:off:0', 's:off:-1', 's:off:abc', 'm:extra', 'M', 'x'.repeat(65), '\u0000', '😈', '../..', '%s%s%s%n',
    ];
    it('ни один мусорный payload не бросает исключение и не меняет данные', async () => {
      const user = await makeUser(prisma);
      const admin = await makeUser(prisma, Role.ADMIN);
      await makeUser(prisma, Role.SUPERADMIN);
      const t = await mkTicket(user);
      const before = await tableCounts(prisma);
      for (const who of [user, admin]) {
        for (const p of garbage) {
          const res = await press(who, p);
          expect(res.all).not.toMatch(/prisma|sql|stack|at .*\(|TypeError|ECONN|relation "/i);
        }
      }
      const after = await tableCounts(prisma);
      expect(after.users).toBe(before.users);
      expect(after.tickets).toBe(before.tickets);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.NEW);
    });

    it('парсер: случайные строки никогда не бросают', () => {
      for (let i = 0; i < 5000; i++) {
        const len = Math.floor(Math.random() * 80);
        const s = Array.from({ length: len }, () => String.fromCharCode(Math.floor(Math.random() * 128))).join('');
        expect(() => parseCallback(s)).not.toThrow();
      }
    });
  });

  describe('Чужие заявки (IDOR) и перебор номеров', () => {
    it('пользователь не получает данные чужих заявок ни одним способом', async () => {
      const victim = await makeUser(prisma);
      const attacker = await makeUser(prisma);
      const t = await mkTicket(victim, { description: 'СЕКРЕТНОЕ ОПИСАНИЕ', photos: [{ token: 'tok-secret', photoId: 1 }] });
      await env.c.adminTickets.addComment(await makeUser(prisma, Role.ADMIN), t.number, 'внутр. секрет', 'INTERNAL');
      const attempts = [cb.ticket(t.number), cb.ticketPhotos(t.number), cb.ticketReply(t.number), cb.adminHistory(t.number), cb.adminStatusMenu(t.number),
        cb.adminCommentMenu(t.number), cb.adminTransferMenu(t.number), cb.adminAccept(t.number), cb.adminStatusSet(t.number, TicketStatus.CLOSED)];
      for (const p of attempts) {
        const res = await press(attacker, p);
        expect(res.all).not.toContain('СЕКРЕТНОЕ');
        expect(res.all).not.toContain('внутр. секрет');
        expect(res.shown.some((s) => s.images?.length)).toBe(false);
      }
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.NEW);
      // перебор номеров: существующая и несуществующая заявки неразличимы
      const real = await press(attacker, cb.ticket(t.number));
      const fake = await press(attacker, cb.ticket(t.number + 1000));
      expect(real.notices).toEqual(fake.notices);
      expect((await env.c.tickets.listForUser(attacker, 'active', 0)).total).toBe(0);
    });

    it('пользователь не видит INTERNAL-комментарии в своей заявке', async () => {
      const user = await makeUser(prisma);
      const admin = await makeUser(prisma, Role.ADMIN);
      const t = await mkTicket(user);
      await env.c.adminTickets.accept(admin, t.number);
      await env.c.adminTickets.addComment(admin, t.number, 'ВНУТРЕННЕЕ-МНЕНИЕ', 'INTERNAL');
      const res = await press(user, cb.ticket(t.number));
      expect(res.all).not.toContain('ВНУТРЕННЕЕ-МНЕНИЕ');
    });
  });

  describe('Повышение привилегий', () => {
    it('обычный пользователь не может выполнить ни одно админское/суперадминское действие', async () => {
      const user = await makeUser(prisma);
      const owner = await makeUser(prisma);
      const t = await mkTicket(owner);
      const target = await makeUser(prisma, Role.ADMIN);
      const payloads = [cb.adminQueue('all'), cb.adminQueue('new'), cb.adminFind, cb.adminAccept(t.number), cb.adminHistory(t.number), cb.adminTransferTo(t.number, user.id),
        cb.superAdmins, cb.superCode, cb.superDisable(target.id)];
      for (const p of payloads) await press(user, p);
      await text(user, '/activate AAAAAAAAAAAA');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe(Role.USER);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe(Role.ADMIN);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.NEW);
      expect(await prisma.adminActivationCode.count()).toBe(0);
    });

    it('обычный админ не управляет другими админами и не создаёт коды', async () => {
      const admin = await makeUser(prisma, Role.ADMIN);
      const other = await makeUser(prisma, Role.ADMIN);
      const root = await makeUser(prisma, Role.SUPERADMIN);
      for (const p of [cb.superAdmins, cb.superCode, cb.superDisable(other.id), cb.superDisable(root.id)]) await press(admin, p);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).role).toBe(Role.ADMIN);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: root.id } })).role).toBe(Role.SUPERADMIN);
      expect(await prisma.adminActivationCode.count()).toBe(0);
    });

    it('даже superadmin не может отключить superadmin', async () => {
      const a = await makeUser(prisma, Role.SUPERADMIN);
      const b = await makeUser(prisma, Role.SUPERADMIN);
      await press(a, cb.superDisable(b.id));
      expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).role).toBe(Role.SUPERADMIN);
    });

    it('коды активации: угадывание, повтор, просроченный, параллельное использование', async () => {
      const root = await env.c.users.ensureSuperadmin(5550002n);
      const { code } = await env.c.activation.createCode(root);
      const u1 = await makeUser(prisma);
      for (const bad of ['AAAAAAAAAAAA', code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'), code.toLowerCase().replace(/./g, 'x'), '', code + code]) await text(u1, `/activate ${bad}`);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u1.id } })).role).toBe(Role.USER);
      // параллельная активация одним кодом пятью людьми — повезёт одному
      const users = await Promise.all(Array.from({ length: 5 }, () => makeUser(prisma)));
      await Promise.all(users.map((u) => text(u, `/activate ${code}`)));
      const promoted = await prisma.user.count({ where: { id: { in: users.map((u) => u.id) }, role: Role.ADMIN } });
      expect(promoted).toBe(1);
      // просроченный
      const { code: old } = await env.c.activation.createCode(root);
      await prisma.adminActivationCode.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const late = await makeUser(prisma);
      await text(late, `/activate ${old}`);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: late.id } })).role).toBe(Role.USER);
      expect(await prisma.auditLog.count({ where: { action: 'ACCESS_DENIED' } })).toBeGreaterThan(0);
    });

    it('в БД хранится только хеш кода активации', async () => {
      const root = await env.c.users.ensureSuperadmin(5550003n);
      const { code } = await env.c.activation.createCode(root);
      const rows = await prisma.adminActivationCode.findMany();
      expect(rows.every((r) => r.codeHash !== code && r.codeHash.length === 64)).toBe(true);
    });

    it('понижение/деактивация: бывший админ мгновенно теряет все права, даже с «зависшей» сессией', async () => {
      const root = await makeUser(prisma, Role.SUPERADMIN);
      const admin = await makeUser(prisma, Role.ADMIN);
      const owner = await makeUser(prisma);
      const t = await mkTicket(owner);
      await env.c.adminTickets.accept(admin, t.number);
      await press(admin, cb.adminCommentStart(t.number, 'user')); // сессия ENTER_COMMENT с commentKind
      await env.c.users.disableAdmin(root, admin.id);
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      await text(fresh, 'комментарий после увольнения');
      expect(await prisma.ticketComment.count()).toBe(0);
      await press(fresh, cb.adminStatusSet(t.number, TicketStatus.RESOLVED));
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.IN_PROGRESS);
    });

    it('админ не может передать заявку обычному пользователю, неактивному, несуществующему и самому себе', async () => {
      const admin = await makeUser(prisma, Role.ADMIN);
      const plain = await makeUser(prisma);
      const dead = await makeUser(prisma, Role.ADMIN);
      await prisma.user.update({ where: { id: dead.id }, data: { isActive: false } });
      const t = await mkTicket(await makeUser(prisma));
      await env.c.adminTickets.accept(admin, t.number);
      for (const target of [plain.id, dead.id, 999999, admin.id]) await press(admin, cb.adminTransferTo(t.number, target));
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).assignedAdminId).toBe(admin.id);
    });

    it('чужой админ и NEW-заявка: нельзя менять статус без принятия', async () => {
      const a = await makeUser(prisma, Role.ADMIN);
      const t = await mkTicket(await makeUser(prisma));
      for (const s of [TicketStatus.CLOSED, TicketStatus.RESOLVED, TicketStatus.IN_PROGRESS]) await press(a, cb.adminStatusSet(t.number, s));
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.NEW);
    });
  });

  describe('Гонки и повторы', () => {
    it('параллельное «Отправить» (двойной тап) создаёт ровно одну заявку', async () => {
      const user = await makeUser(prisma);
      await press(user, cb.userNew);
      await press(user, cb.userBranch(env.branchId));
      await text(user, '12');
      await text(user, 'монитор');
      await Promise.all(Array.from({ length: 10 }, () => press(user, cb.userSend)));
      expect(await prisma.ticket.count()).toBe(1);
    });

    it('лимит: не более 5 заявок за 10 минут от одного пользователя', async () => {
      const user = await makeUser(prisma);
      await makeUser(prisma, Role.ADMIN);
      await Promise.allSettled(Array.from({ length: 12 }, () => mkTicket(user)));
      expect(await prisma.ticket.count()).toBe(5); // строго, даже при параллельных запросах
      await expect(mkTicket(user)).rejects.toThrow();
      // другой пользователь не затронут
      await expect(mkTicket(await makeUser(prisma))).resolves.toBeDefined();
    });

    it('одновременные смены статуса и закрытие: итоговое состояние согласовано с историей', async () => {
      const admin = await makeUser(prisma, Role.ADMIN);
      const t = await mkTicket(await makeUser(prisma));
      await env.c.adminTickets.accept(admin, t.number);
      await Promise.allSettled([
        env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.RESOLVED),
        env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.POSTPONED),
        env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.WAITING_USER),
        env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.CLOSED),
      ]);
      const fresh = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      const hist = await prisma.ticketStatusHistory.findMany({ where: { ticketId: t.id }, orderBy: { id: 'asc' } });
      expect(hist[hist.length - 1]?.newStatus).toBe(fresh.status);
    });

    it('повтор одного и того же update не обрабатывается дважды (replay)', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => env.c.dedupe.claim('cb:replay-1')));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('Целостность данных и устойчивость', () => {
    it('огромные и странные входные данные не приводят к падению или сохранению сверх лимитов', async () => {
      const user = await makeUser(prisma);
      await press(user, cb.userNew);
      await press(user, cb.userBranch(env.branchId));
      const r = await text(user, 'x'.repeat(1_000_000));
      expect(r.all).toContain('Максимум 100');
      await text(user, '12');
      const r2 = await text(user, 'y'.repeat(5_000_000));
      expect(r2.all).toContain('Максимум 2000');
      expect(await prisma.ticket.count()).toBe(0);
    });

    it('фото: невалидные/огромные токены и превышение лимита не ломают заявку', async () => {
      const user = await makeUser(prisma);
      const photos = Array.from({ length: 50 }, (_, i) => ({ token: `'; DROP TABLE "Ticket";-- ${i}`.slice(0, 500), photoId: i }));
      const t = await mkTicket(user, { photos });
      expect(t._count.attachments).toBe(5);
      expect(await prisma.ticket.count()).toBe(1);
    });

    it('в ответах пользователю нет внутренних деталей при внутренней ошибке', async () => {
      const user = await makeUser(prisma);
      await prisma.$executeRawUnsafe('ALTER TABLE "UserSession" RENAME TO "UserSession_x"');
      try {
        const r = await text(user, 'привет');
        expect(r.all).toContain('Что-то пошло не так');
        expect(r.all).not.toMatch(/UserSession|relation|prisma|SELECT/i);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "UserSession_x" RENAME TO "UserSession"');
      }
    });

    it('аудит: отказы в доступе фиксируются, а запись аудита невозможно подменить через ввод', async () => {
      const user = await makeUser(prisma);
      await press(user, cb.superCode);
      const log = await prisma.auditLog.findFirst({ where: { action: 'ACCESS_DENIED', actorId: user.id } });
      expect(log).not.toBeNull();
    });

    it('неактивный пользователь заблокирован на уровне сессии', async () => {
      const user = await makeUser(prisma);
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      await prisma.userSession.upsert({ where: { userId: user.id }, create: { userId: user.id, state: SessionState.CONFIRM }, update: {} });
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      await expect(env.c.tickets.create(fresh, { branchId: env.branchId, room: '1', description: 'x' })).rejects.toThrow();
    });
  });
});

describe('HTTP-периметр', () => {
  const SECRET = 'secret_12345';
  const received: unknown[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const hook = new Webhook(new Api({ call: async () => ({ status: 200, data: {} }) }), [], 'tok-tok-tok-tok', { domain: 'x.test', path: WEBHOOK_PATH, secret: SECRET });
    const cbk = hook.createCallback(async (u) => { received.push(u); });
    app = await buildApp({ prisma: new PrismaClient({ datasources: { db: { url: 'postgresql://x:y@127.0.0.1:1/n' } } }), log: logger.child({}, { level: 'silent' }), webhookCallback: cbk });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  const post = (headers: Record<string, string>, payload: string) => app.inject({ method: 'POST', url: WEBHOOK_PATH, headers: { 'content-type': 'application/json', ...headers }, payload });

  it('секрет: отсутствует, пустой, неверный, префикс, суффикс, разный регистр, лишние пробелы', async () => {
    const body = JSON.stringify({ update_type: 'bot_started', timestamp: 1 });
    for (const h of [{} as Record<string, string>, { 'x-max-bot-api-secret': '' }, { 'x-max-bot-api-secret': 'secret_1234' }, { 'x-max-bot-api-secret': 'secret_123456' },
      { 'x-max-bot-api-secret': SECRET.toUpperCase() }, { 'x-max-bot-api-secret': ` ${SECRET}` }, { 'x-max-bot-api-secret': `${SECRET}\n` }, { authorization: SECRET }]) {
      const res = await post(h, body);
      expect(res.statusCode).toBe(404);
    }
    expect(received).toHaveLength(0);
  });

  it('секрет в query/path вместо заголовка не принимается', async () => {
    const res = await app.inject({ method: 'POST', url: `${WEBHOOK_PATH}?secret=${SECRET}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(404);
  });

  it('тело больше лимита отвергается (413) даже с верным секретом', async () => {
    const big = JSON.stringify({ update_type: 'bot_started', timestamp: 1, pad: 'a'.repeat(5 * 1024 * 1024) });
    const res = await post({ 'x-max-bot-api-secret': SECRET }, big);
    expect(res.statusCode).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('битый JSON не роняет сервер', async () => {
    for (const bad of ['{', '', 'null', '[]', '{"update_type":', '\u0000\u0000']) {
      const res = await post({ 'x-max-bot-api-secret': SECRET }, bad);
      expect([200, 400]).toContain(res.statusCode);
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBeGreaterThan(0);
  });

  it('другие методы и пути недоступны, служебные не раскрываются', async () => {
    for (const [method, url] of [['GET', WEBHOOK_PATH], ['PUT', WEBHOOK_PATH], ['DELETE', WEBHOOK_PATH], ['GET', '/'], ['GET', '/admin'], ['GET', '/.env'],
      ['GET', '/../../etc/passwd'], ['GET', '/metrics'], ['GET', '/docs'], ['POST', '/health'], ['GET', '/webhook/max/../health']] as const) {
      const res = await app.inject({ method, url });
      expect([404, 405, 400]).toContain(res.statusCode);
      expect(res.body).not.toMatch(/stack|prisma|node_modules|Error:/i);
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('/health не раскрывает деталей при недоступной БД', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error' });
  });

  it('rate limit срабатывает при флуде', async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 700; i++) codes.add((await app.inject({ method: 'GET', url: '/nope' })).statusCode);
    expect(codes.has(429)).toBe(true);
  });
});
