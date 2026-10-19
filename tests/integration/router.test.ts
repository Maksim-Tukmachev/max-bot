import { PrismaClient, Role, SessionState, TicketStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Responder } from '../../src/bot/types';
import { PATIENT_DATA_WARNING } from '../../src/config/constants';
import { cb } from '../../src/security/callback-data';
import type { Screen } from '../../src/types/messenger';
import { TEST_DB_URL, createPrismaForTests, makeUser, setup, type TestEnv } from './helpers';

class Recorder implements Responder {
  shown: Screen[] = [];
  notices: string[] = [];
  async show(s: Screen) {
    this.shown.push(s);
  }
  async notify(t: string) {
    this.notices.push(t);
  }
  get last(): Screen {
    return this.shown[this.shown.length - 1] as Screen;
  }
}

describe.skipIf(!TEST_DB_URL)('router FSM (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let env: TestEnv;
  beforeAll(() => {
    prisma = createPrismaForTests();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    env = await setup(prisma);
  });

  it('полный сценарий: филиал → кабинет → описание → подтверждение → заявка', async () => {
    const user = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const r = env.c.router;
    const res = new Recorder();

    await r.handle({ kind: 'callback', user, payload: cb.userNew }, res);
    expect(res.last.text).toContain('филиал');
    await r.handle({ kind: 'callback', user, payload: cb.userBranch(env.branchId) }, res);
    await r.handle({ kind: 'text', user, text: '   ' }, res);
    expect(res.last.text).toContain('не может быть пустым');
    await r.handle({ kind: 'text', user, text: '305' }, res);
    expect(res.last.text).toContain(PATIENT_DATA_WARNING);
    await r.handle({ kind: 'text', user, text: 'Не включается компьютер' }, res);
    expect(res.last.text).toContain('Проверьте заявку');
    expect(res.last.keyboard?.flat().map((b) => b.text)).toEqual(expect.arrayContaining(['📨 Отправить', '✏️ Изменить', '✖️ Отмена']));
    expect(await prisma.ticket.count()).toBe(0);

    await r.handle({ kind: 'callback', user, payload: cb.userSend }, res);
    await r.handle({ kind: 'callback', user, payload: cb.userSend }, res); // повторное нажатие
    expect(await prisma.ticket.count()).toBe(1);
    expect(res.notices).toContain('Действие недоступно.');
    const session = await prisma.userSession.findUniqueOrThrow({ where: { userId: user.id } });
    expect(session.state).toBe(SessionState.IDLE);
    expect(env.messenger.textsTo(admin.maxUserId)[0]).toContain('Новая заявка');
  });

  it('фото до описания копятся в черновике и попадают в заявку; чужой не откроет фото', async () => {
    const user = await makeUser(prisma);
    const stranger = await makeUser(prisma);
    const r = env.c.router;
    const res = new Recorder();

    await r.handle({ kind: 'callback', user, payload: cb.userNew }, res);
    await r.handle({ kind: 'callback', user, payload: cb.userBranch(env.branchId) }, res);
    await r.handle({ kind: 'text', user, text: '7' }, res);
    await r.handle({ kind: 'text', user, text: '', images: [{ token: 'a1', photoId: 1 }, { token: 'a2', photoId: 2 }] }, res);
    expect(res.last.text).toContain('Фото добавлено (2/5)');
    await r.handle({ kind: 'text', user, text: '', images: [{ token: 'a2', photoId: 2 }], hasOtherMedia: true }, res);
    expect(res.last.text).toContain('Фото добавлено (2/5)'); // дубль не добавлен
    expect(res.last.text).toContain('только фото');
    await r.handle({ kind: 'text', user, text: 'Сломан монитор', images: [{ token: 'a3', photoId: 3 }] }, res);
    expect(res.last.text).toContain('Фото: 3');
    await r.handle({ kind: 'callback', user, payload: cb.userSend }, res);

    const ticket = await prisma.ticket.findFirstOrThrow();
    await r.handle({ kind: 'callback', user, payload: cb.ticketPhotos(ticket.number) }, res);
    expect(res.last.images).toEqual(['a1', 'a2', 'a3']);
    const stranger_res = new Recorder();
    await r.handle({ kind: 'callback', user: stranger, payload: cb.ticketPhotos(ticket.number) }, stranger_res);
    expect(stranger_res.shown).toHaveLength(0);
    expect(stranger_res.notices).toHaveLength(1);
  });

  it('обычный пользователь не может выполнить админский callback', async () => {
    const user = await makeUser(prisma);
    const owner = await makeUser(prisma);
    const t = await env.c.tickets.create(owner, { branchId: env.branchId, room: '1', description: 'x' });
    const res = new Recorder();

    await env.c.router.handle({ kind: 'callback', user, payload: cb.adminAccept(t.number) }, res);

    expect(res.notices).toContain('Недостаточно прав для этого действия.');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.NEW);
  });

  it('поддельный callback не вызывает ошибок и ничего не меняет', async () => {
    const user = await makeUser(prisma);
    const res = new Recorder();
    await env.c.router.handle({ kind: 'callback', user, payload: 'a:acc:-5;DROP' }, res);
    expect(res.notices).toEqual(['Действие недоступно.']);
  });

  it('админ комментирует через текстовый ввод; ответ пользователя возвращает заявку в работу', async () => {
    const user = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(user, { branchId: env.branchId, room: '1', description: 'x' });
    await env.c.adminTickets.accept(admin, t.number);
    await env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.WAITING_USER);
    const res = new Recorder();

    await env.c.router.handle({ kind: 'callback', user: admin, payload: cb.adminCommentStart(t.number, 'user') }, res);
    await env.c.router.handle({ kind: 'text', user: admin, text: 'Уточните модель' }, res);
    expect(env.messenger.textsTo(user.maxUserId).join('\n')).toContain('Уточните модель');

    await env.c.router.handle({ kind: 'callback', user, payload: cb.ticketReply(t.number) }, res);
    await env.c.router.handle({ kind: 'text', user, text: 'HP LaserJet' }, res);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(TicketStatus.IN_PROGRESS);
    expect(env.messenger.textsTo(admin.maxUserId).join('\n')).toContain('HP LaserJet');
  });

  it('/activate превращает пользователя в админа и просит удалить сообщение с кодом', async () => {
    const root = await env.c.users.ensureSuperadmin(900001n);
    const { code } = await env.c.activation.createCode(root);
    const newcomer = await makeUser(prisma);
    const res = new Recorder();
    const result = await env.c.router.handle({ kind: 'text', user: newcomer, text: `/activate ${code}` }, res);
    expect(result.deleteSourceMessage).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: newcomer.id } })).role).toBe(Role.ADMIN);
  });
});
