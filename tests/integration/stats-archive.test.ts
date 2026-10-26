import { PrismaClient, Role, TicketStatus, type User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Responder } from '../../src/bot/types';
import { cb } from '../../src/security/callback-data';
import type { Screen } from '../../src/types/messenger';
import { ForbiddenError } from '../../src/utils/errors';
import { TEST_DB_URL, createPrismaForTests, makeUser, setup, type TestEnv } from './helpers';

class Rec implements Responder {
  shown: Screen[] = [];
  notices: string[] = [];
  async show(s: Screen) { this.shown.push(s); }
  async notify(t: string) { this.notices.push(t); }
  get last(): Screen { return this.shown[this.shown.length - 1] as Screen; }
}

// «Сейчас» = 20.10.2026 15:00 по Москве. Московские сутки: 20.10 = [19.10 21:00Z, 20.10 21:00Z).
const NOW = new Date('2026-10-20T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe.skipIf(!TEST_DB_URL)('статистика и архив (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let env: TestEnv;
  let branchB: number;
  let a1: User;
  let a2: User;
  let root: User;
  let author: User;
  let author2: User;

  beforeAll(() => { prisma = createPrismaForTests(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    env = await setup(prisma);
    branchB = (await prisma.branch.create({ data: { name: 'Второй филиал' } })).id;
    a1 = await makeUser(prisma, Role.ADMIN, 'Админ1');
    a2 = await makeUser(prisma, Role.ADMIN, 'Админ2');
    root = await makeUser(prisma, Role.SUPERADMIN, 'Босс');
    author = await makeUser(prisma, Role.USER, 'Автор');
    author2 = await makeUser(prisma, Role.USER, 'Автор2');
  });

  interface Seed {
    createdAt: string;
    by?: User;
    branchId?: number;
    description?: string;
    room?: string;
    accept?: { admin: User; at: string };
    done?: { admin: User; at: string; status?: TicketStatus };
    closedAt?: string;
    status?: TicketStatus;
  }

  async function seed(s: Seed) {
    const status = s.status ?? (s.closedAt ? TicketStatus.CLOSED : s.done ? TicketStatus.RESOLVED : s.accept ? TicketStatus.IN_PROGRESS : TicketStatus.NEW);
    const t = await prisma.ticket.create({
      data: {
        userId: (s.by ?? author).id,
        branchId: s.branchId ?? env.branchId,
        room: s.room ?? '1',
        description: s.description ?? 'описание',
        status,
        createdAt: at(s.createdAt),
        acceptedAt: s.accept ? at(s.accept.at) : null,
        assignedAdminId: s.accept ? s.accept.admin.id : null,
        closedAt: s.closedAt ? at(s.closedAt) : null,
        resolvedAt: s.done ? at(s.done.at) : null,
      },
    });
    await prisma.ticketStatusHistory.create({ data: { ticketId: t.id, oldStatus: null, newStatus: TicketStatus.NEW, changedBy: (s.by ?? author).id, createdAt: at(s.createdAt) } });
    if (s.accept) {
      await prisma.ticketStatusHistory.create({ data: { ticketId: t.id, oldStatus: 'NEW', newStatus: 'IN_PROGRESS', changedBy: s.accept.admin.id, createdAt: at(s.accept.at) } });
    }
    if (s.done) {
      await prisma.ticketStatusHistory.create({ data: { ticketId: t.id, oldStatus: 'IN_PROGRESS', newStatus: s.done.status ?? 'RESOLVED', changedBy: s.done.admin.id, createdAt: at(s.done.at) } });
    }
    return t;
  }

  async function seedWeek() {
    // сегодня (20.10 МСК)
    await seed({ createdAt: '2026-10-20T07:00:00Z', accept: { admin: a1, at: '2026-10-20T07:30:00Z' }, done: { admin: a1, at: '2026-10-20T09:00:00Z', status: TicketStatus.CLOSED }, closedAt: '2026-10-20T09:00:00Z' });
    await seed({ createdAt: '2026-10-20T08:00:00Z', branchId: branchB, by: author2, accept: { admin: a2, at: '2026-10-20T09:00:00Z' } });
    // граница суток: 00:30 МСК 20.10 = 19.10 21:30Z — относится к 20.10
    await seed({ createdAt: '2026-10-19T21:30:00Z' });
    // вчера
    await seed({ createdAt: '2026-10-19T10:00:00Z', accept: { admin: a1, at: '2026-10-19T11:00:00Z' }, done: { admin: a1, at: '2026-10-19T13:00:00Z', status: TicketStatus.CLOSED }, closedAt: '2026-10-19T13:00:00Z' });
    // 8 дней назад (вне 7 дней, внутри 14 и 30)
    await seed({ createdAt: '2026-10-12T10:00:00Z', by: author2, branchId: branchB, accept: { admin: a2, at: '2026-10-12T10:10:00Z' }, done: { admin: a2, at: '2026-10-12T12:00:00Z', status: TicketStatus.CLOSED }, closedAt: '2026-10-12T12:00:00Z' });
    // 25 дней назад
    await seed({ createdAt: '2026-09-25T10:00:00Z' });
  }

  it('сводка: создано/закрыто за периоды, сутки считаются в часовом поясе отчётов', async () => {
    await seedWeek();
    const today = await env.c.stats.overview(a1, 1, NOW);
    expect(today.data.created).toBe(3); // включая 00:30 МСК
    expect(today.data.closed).toBe(1);
    expect(today.range).toEqual({ fromDay: '2026-10-20', toDay: '2026-10-21' });
    const week = await env.c.stats.overview(a1, 2, NOW);
    expect(week.data.created).toBe(4);
    expect(week.data.closed).toBe(2);
    const month = await env.c.stats.overview(a1, 3, NOW);
    expect(month.data.created).toBe(6);
    expect(month.data.closed).toBe(3);
    // среднее время до принятия: (30 мин + 60 мин + 10 мин) / 3 за месяц; у остальных нет accept
    expect(Math.round((month.data.avgAcceptSeconds ?? 0) / 60)).toBe(Math.round((30 + 60 + 60 + 10) / 4));
    expect(week.data.byBranch.map((b) => [b.name, b.count])).toEqual(expect.arrayContaining([['Тестовый филиал', 3], ['Второй филиал', 1]]));
    expect(month.data.current.NEW).toBe(2);
  });

  it('по дням: непрерывный ряд, нули в пустые дни, корректные суммы', async () => {
    await seedWeek();
    const d = await env.c.stats.daily(a1, 1, NOW);
    expect(d.data).toHaveLength(7);
    expect(d.data[d.data.length - 1]).toEqual({ day: '2026-10-20', created: 3, closed: 1 });
    expect(d.data.find((x) => x.day === '2026-10-19')).toEqual({ day: '2026-10-19', created: 1, closed: 1 });
    expect(d.data.find((x) => x.day === '2026-10-17')).toEqual({ day: '2026-10-17', created: 0, closed: 0 });
    const d30 = await env.c.stats.daily(a1, 3, NOW);
    expect(d30.data).toHaveLength(30);
    expect(d30.data.reduce((s, x) => s + x.created, 0)).toBe(6);
  });

  it('по неделям (с понедельника): неделя 19–25.10 содержит 20.10 и 19.10, предыдущая — 12.10', async () => {
    await seedWeek();
    const w = await env.c.stats.weekly(a1, 1, NOW);
    expect(w.data).toHaveLength(4);
    const cur = w.data[w.data.length - 1];
    expect(cur).toEqual({ weekStart: '2026-10-19', created: 4, closed: 2 });
    expect(w.data[w.data.length - 2]).toEqual({ weekStart: '2026-10-12', created: 1, closed: 1 });
    expect(w.data.reduce((s, x) => s + x.created, 0)).toBe(5); // 25.09 — старше 4 недель
    const w12 = await env.c.stats.weekly(a1, 3, NOW);
    expect(w12.data).toHaveLength(12);
    expect(w12.data.reduce((s, x) => s + x.created, 0)).toBe(6);
  });

  it('сотрудники: принял/выполнил/среднее время/нагрузка; суперадмин видит всех', async () => {
    await seedWeek();
    const s = await env.c.stats.staff(root, 3, NOW);
    expect(s.onlyOwn).toBe(false);
    const row = (u: User) => s.data.find((e) => e.adminId === u.id);
    expect(row(a1)).toMatchObject({ accepted: 2, done: 2, load: 0 });
    expect(Math.round((row(a1)?.avgDoneSeconds ?? 0) / 3600)).toBe(Math.round((2 + 3) / 2)); // 2 ч и 3 ч от создания
    expect(row(a2)).toMatchObject({ accepted: 2, done: 1, load: 1 });
    expect(row(root)).toMatchObject({ accepted: 0, done: 0 });
    expect(s.data[0]?.adminId).toBe(a1.id); // отсортировано по «выполнил»
  });

  it('обычный админ видит в разделе «Сотрудники» только себя', async () => {
    await seedWeek();
    const s = await env.c.stats.staff(a1, 3, NOW);
    expect(s.onlyOwn).toBe(true);
    expect(s.data.map((e) => e.adminId)).toEqual([a1.id]);
  });

  it('заявка, решённая одним и закрытая другим, засчитывается только первому', async () => {
    const t = await seed({ createdAt: '2026-10-20T07:00:00Z', accept: { admin: a1, at: '2026-10-20T07:10:00Z' }, done: { admin: a1, at: '2026-10-20T08:00:00Z', status: TicketStatus.RESOLVED }, closedAt: '2026-10-20T09:00:00Z' });
    await prisma.ticketStatusHistory.create({ data: { ticketId: t.id, oldStatus: 'RESOLVED', newStatus: 'CLOSED', changedBy: a2.id, createdAt: at('2026-10-20T09:00:00Z') } });
    const s = await env.c.stats.staff(root, 1, NOW);
    expect(s.data.find((e) => e.adminId === a1.id)?.done).toBe(1);
    expect(s.data.find((e) => e.adminId === a2.id)?.done).toBe(0);
  });

  it('уволенный админ с историей работ остаётся в статистике', async () => {
    await seed({ createdAt: '2026-10-20T07:00:00Z', accept: { admin: a2, at: '2026-10-20T07:10:00Z' } });
    await env.c.users.disableAdmin(root, a2.id);
    const s = await env.c.stats.staff(root, 1, NOW);
    expect(s.data.find((e) => e.adminId === a2.id)?.accepted).toBe(1);
  });

  it('кто чаще обращается: только для суперадмина', async () => {
    await seedWeek();
    const r = await env.c.stats.requesters(root, 3, NOW);
    expect(r.data[0]?.count).toBe(4);
    expect(r.data[0]?.name).toContain('Автор');
    await expect(env.c.stats.requesters(a1, 3, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('обычный пользователь не получает никакую статистику и архив', async () => {
    await expect(env.c.stats.overview(author, 2, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(env.c.stats.daily(author, 2, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(env.c.stats.weekly(author, 2, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(env.c.stats.staff(author, 2, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(env.c.adminTickets.archive(author, { since: null, branchId: null, query: null }, 0)).rejects.toBeInstanceOf(ForbiddenError);
    const res = new Rec();
    await env.c.router.handle({ kind: 'callback', user: author, payload: cb.adminStats('overview', 2) }, res);
    await env.c.router.handle({ kind: 'callback', user: author, payload: cb.adminArchive('a') }, res);
    expect(res.shown).toHaveLength(0);
  });

  it('экраны статистики строятся через бота, без пустых/ошибочных ответов', async () => {
    await seedWeek();
    const res = new Rec();
    for (const view of ['overview', 'days', 'weeks', 'staff', 'users'] as const) {
      for (const idx of [1, 2, 3] as const) {
        await env.c.router.handle({ kind: 'callback', user: root, payload: cb.adminStats(view, idx) }, res);
      }
    }
    expect(res.notices).toEqual([]);
    expect(res.shown).toHaveLength(15);
    expect(res.shown.every((s) => s.text.length > 20 && s.text.length < 4000)).toBe(true);
    expect(res.shown[0]?.text).toContain('Создано заявок');
    // у обычного админа нет кнопки «Кто обращается», у суперадмина есть
    const adminRes = new Rec();
    await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminStatsMenu }, adminRes);
    const rootRes = new Rec();
    await env.c.router.handle({ kind: 'callback', user: root, payload: cb.adminStatsMenu }, rootRes);
    const labels = (r: Rec) => r.last.keyboard?.flat().map((b) => b.text) ?? [];
    expect(labels(adminRes).some((l) => l.includes('Кто обращается'))).toBe(false);
    expect(labels(rootRes).some((l) => l.includes('Кто обращается'))).toBe(true);
  });

  describe('архив', () => {
    async function seedArchive() {
      for (let i = 0; i < 10; i++) {
        await seed({ createdAt: `2026-10-0${1 + (i % 9)}T10:00:00Z`, closedAt: `2026-10-1${i % 10}T12:00:00Z`, description: `поломка ${i}`, room: `${100 + i}` });
      }
      await seed({ createdAt: '2026-10-05T10:00:00Z', closedAt: '2026-10-18T12:00:00Z', branchId: branchB, by: author2, description: 'не работает ПРИНТЕР', room: 'каб. 7' });
      await seed({ createdAt: '2026-10-05T10:00:00Z', description: 'ещё не закрыта' });
    }

    it('показывает только закрытые, новые сверху, с пагинацией по 8', async () => {
      await seedArchive();
      const p0 = await env.c.adminTickets.archive(a1, { since: null, branchId: null, query: null }, 0);
      expect(p0.total).toBe(11);
      expect(p0.pages).toBe(2);
      expect(p0.items).toHaveLength(8);
      expect(p0.items.every((t) => t.status === TicketStatus.CLOSED)).toBe(true);
      const dates = p0.items.map((t) => t.closedAt?.getTime() ?? 0);
      expect([...dates].sort((a, b) => b - a)).toEqual(dates);
      const p1 = await env.c.adminTickets.archive(a1, { since: null, branchId: null, query: null }, 1);
      expect(p1.items).toHaveLength(3);
      const numbers = new Set([...p0.items, ...p1.items].map((t) => t.number));
      expect(numbers.size).toBe(11);
    });

    it('фильтры: период, филиал, поиск по описанию/кабинету/автору без учёта регистра', async () => {
      await seedArchive();
      const f = (x: Partial<{ since: Date | null; branchId: number | null; query: string | null }>) =>
        env.c.adminTickets.archive(a1, { since: null, branchId: null, query: null, ...x }, 0);
      expect((await f({ since: at('2026-10-17T00:00:00Z') })).total).toBe(4); // 17, 18, 19 и заявка второго филиала от 18
      expect((await f({ branchId: branchB })).total).toBe(1);
      expect((await f({ query: 'принтер' })).total).toBe(1);
      expect((await f({ query: 'КАБ. 7' })).total).toBe(1);
      expect((await f({ query: 'Автор2' })).total).toBe(1);
      expect((await f({ query: 'поломка' })).total).toBe(10);
      expect((await f({ query: 'нет такого' })).total).toBe(0);
      expect((await f({ branchId: branchB, query: 'поломка' })).total).toBe(0);
    });

    it('поиск: % и _ ищутся буквально, SQL-инъекции не работают', async () => {
      await seedArchive();
      const f = (query: string) => env.c.adminTickets.archive(a1, { since: null, branchId: null, query }, 0);
      expect((await f('%')).total).toBe(0);
      expect((await f('_')).total).toBe(0);
      expect((await f('100%')).total).toBe(0);
      for (const q of [`'; DROP TABLE "Ticket"; --`, `' OR '1'='1`, `\\`, `"`]) expect((await f(q)).total).toBe(0);
      expect(await prisma.ticket.count()).toBe(12);
    });

    it('через бота: поиск → страницы сохраняют запрос → открытие заявки не сбрасывает поиск', async () => {
      await seedArchive();
      const res = new Rec();
      await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminArchive('a') }, res);
      expect(res.last.text).toContain('Найдено: 11');
      await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminArchiveSearch('a', 0) }, res);
      await env.c.router.handle({ kind: 'text', user: a1, text: 'поломка' }, res);
      expect(res.last.text).toContain('Поиск: «поломка»');
      expect(res.last.text).toContain('Найдено: 10');
      const next = res.last.keyboard?.flat().find((b) => b.text.includes('Вперёд'));
      expect(next?.payload).toBe(cb.adminArchive('a', 0, 1, true));
      // открыли карточку и вернулись на следующую страницу — запрос сохранился
      const first = res.last.keyboard?.flat().find((b) => b.payload.startsWith('t:'));
      await env.c.router.handle({ kind: 'callback', user: a1, payload: first?.payload ?? '' }, res);
      await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminArchive('a', 0, 1, true) }, res);
      expect(res.last.text).toContain('Поиск: «поломка»');
      expect(res.last.text).toContain('Найдено: 10');
      // сброс фильтров
      const reset = res.last.keyboard?.flat().find((b) => b.text.includes('Сбросить'));
      await env.c.router.handle({ kind: 'callback', user: a1, payload: reset?.payload ?? '' }, res);
      expect(res.last.text).toContain('Найдено: 11');
      expect(res.last.text).not.toContain('Поиск:');
    });

    it('через бота: выбор филиала и пустой результат', async () => {
      await seedArchive();
      const res = new Rec();
      await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminArchiveBranches('a', false) }, res);
      const pick = res.last.keyboard?.flat().find((b) => b.text === 'Второй филиал');
      await env.c.router.handle({ kind: 'callback', user: a1, payload: pick?.payload ?? '' }, res);
      expect(res.last.text).toContain('Филиал: Второй филиал');
      expect(res.last.text).toContain('Найдено: 1');
      await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminArchive('t') }, res);
      expect(res.last.text).toContain('Заявок не найдено');
    });

    it('слишком длинный и пустой запрос поиска отклоняются, состояние не ломается', async () => {
      const res = new Rec();
      await env.c.router.handle({ kind: 'callback', user: a1, payload: cb.adminArchiveSearch('a', 0) }, res);
      await env.c.router.handle({ kind: 'text', user: a1, text: 'я'.repeat(101) }, res);
      expect(res.last.text).toContain('Максимум 100');
      await env.c.router.handle({ kind: 'text', user: a1, text: '   ' }, res);
      expect(res.last.text).toMatch(/пустым/);
    });
  });
});
