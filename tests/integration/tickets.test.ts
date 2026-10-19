import { CommentVisibility, PrismaClient, Role, TicketStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '../../src/domain/enums';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../src/utils/errors';
import { TEST_DB_URL, createPrismaForTests, makeUser, setup, type TestEnv } from './helpers';

describe.skipIf(!TEST_DB_URL)('tickets (PostgreSQL)', () => {
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

  const draft = () => ({ branchId: env.branchId, room: '12', description: 'Не работает принтер' });

  it('создаёт заявку, пишет историю и аудит, уведомляет всех активных админов', async () => {
    const user = await makeUser(prisma);
    const a1 = await makeUser(prisma, Role.ADMIN);
    const a2 = await makeUser(prisma, Role.SUPERADMIN);
    const off = await makeUser(prisma, Role.ADMIN);
    await prisma.user.update({ where: { id: off.id }, data: { isActive: false } });

    const t = await env.c.tickets.create(user, draft());

    expect(t.number).toBeGreaterThan(0);
    expect(t.status).toBe(TicketStatus.NEW);
    expect(await prisma.ticketStatusHistory.count({ where: { ticketId: t.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.TicketCreated } })).toBe(1);
    expect(env.messenger.textsTo(a1.maxUserId)).toHaveLength(1);
    expect(env.messenger.textsTo(a2.maxUserId)).toHaveLength(1);
    expect(env.messenger.textsTo(off.maxUserId)).toHaveLength(0);
  });

  it('сохраняет фото (не более 5) и отдаёт их только владельцу и админам', async () => {
    const owner = await makeUser(prisma);
    const stranger = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const photos = Array.from({ length: 7 }, (_, i) => ({ token: `tok-${i}`, photoId: 100 + i }));

    const t = await env.c.tickets.create(owner, { ...draft(), photos });

    expect(t._count.attachments).toBe(5);
    expect(await env.c.tickets.photosFor(owner, t.number)).toEqual(['tok-0', 'tok-1', 'tok-2', 'tok-3', 'tok-4']);
    expect(await env.c.tickets.photosFor(admin, t.number)).toHaveLength(5);
    await expect(env.c.tickets.photosFor(stranger, t.number)).rejects.toBeInstanceOf(NotFoundError);
    expect(env.messenger.textsTo(admin.maxUserId)[0]).toContain('Фото: 5');
  });

  it('валидирует поля заявки', async () => {
    const user = await makeUser(prisma);
    await expect(env.c.tickets.create(user, { ...draft(), room: '   ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(env.c.tickets.create(user, { ...draft(), room: 'x'.repeat(101) })).rejects.toBeInstanceOf(ValidationError);
    await expect(env.c.tickets.create(user, { ...draft(), description: 'x'.repeat(2001) })).rejects.toBeInstanceOf(ValidationError);
    await expect(env.c.tickets.create(user, { ...draft(), branchId: 999999 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('не даёт пользователю смотреть чужую заявку и пишет ACCESS_DENIED', async () => {
    const owner = await makeUser(prisma);
    const stranger = await makeUser(prisma);
    const t = await env.c.tickets.create(owner, draft());

    await expect(env.c.tickets.getForViewer(stranger, t.number)).rejects.toBeInstanceOf(NotFoundError);
    expect((await env.c.tickets.getForViewer(owner, t.number)).id).toBe(t.id);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.AccessDenied, actorId: stranger.id } })).toBe(1);
    const listed = await env.c.tickets.listForUser(stranger, 'active', 0);
    expect(listed.total).toBe(0);
  });

  it('админ принимает заявку; пользователь получает уведомление', async () => {
    const user = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(user, draft());

    const accepted = await env.c.adminTickets.accept(admin, t.number);

    expect(accepted.status).toBe(TicketStatus.IN_PROGRESS);
    expect(accepted.assignedAdminId).toBe(admin.id);
    expect(accepted.acceptedAt).not.toBeNull();
    expect(env.messenger.textsTo(user.maxUserId)).toContain(`Заявка #${t.number} принята в работу`);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.TicketAccepted } })).toBe(1);
  });

  it('при одновременном принятии заявка достаётся ровно одному админу', async () => {
    const user = await makeUser(prisma);
    const admins = await Promise.all(Array.from({ length: 8 }, () => makeUser(prisma, Role.ADMIN)));
    const t = await env.c.tickets.create(user, draft());

    const results = await Promise.allSettled(admins.map((a) => env.c.adminTickets.accept(a, t.number)));

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const r of lost) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    const fresh = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    const winnerId = (won[0] as PromiseFulfilledResult<{ assignedAdminId: number }>).value.assignedAdminId;
    expect(fresh.assignedAdminId).toBe(winnerId);
    expect(await prisma.ticketStatusHistory.count({ where: { ticketId: t.id, newStatus: TicketStatus.IN_PROGRESS } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.TicketAccepted } })).toBe(1);
  });

  it('меняет статус по допустимым переходам и отправляет «выполнена» при закрытии', async () => {
    const user = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(user, draft());
    await env.c.adminTickets.accept(admin, t.number);

    await env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.WAITING_USER);
    await expect(env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.CLOSED)).rejects.toBeInstanceOf(ConflictError);
    await env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.IN_PROGRESS);
    await env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.RESOLVED);
    const closed = await env.c.adminTickets.changeStatus(admin, t.number, TicketStatus.CLOSED);

    expect(closed.closedAt).not.toBeNull();
    expect(env.messenger.textsTo(user.maxUserId)).toContain(`Заявка #${t.number} выполнена`);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.TicketClosed } })).toBe(1);
    const history = await env.c.adminTickets.historyOf(admin, t.number);
    expect(history.length).toBeGreaterThanOrEqual(6);
  });

  it('проверяет права: обычный пользователь не принимает и не меняет, чужой админ не меняет статус', async () => {
    const user = await makeUser(prisma);
    const other = await makeUser(prisma);
    const admin1 = await makeUser(prisma, Role.ADMIN);
    const admin2 = await makeUser(prisma, Role.ADMIN);
    const root = await makeUser(prisma, Role.SUPERADMIN);
    const t = await env.c.tickets.create(user, draft());

    await expect(env.c.adminTickets.accept(other, t.number)).rejects.toBeInstanceOf(ForbiddenError);
    await env.c.adminTickets.accept(admin1, t.number);
    await expect(env.c.adminTickets.changeStatus(admin2, t.number, TicketStatus.RESOLVED)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(env.c.adminTickets.changeStatus(other, t.number, TicketStatus.RESOLVED)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(env.c.users.disableAdmin(admin1, admin2.id)).rejects.toBeInstanceOf(ForbiddenError);
    // superadmin может управлять чужой заявкой
    const res = await env.c.adminTickets.changeStatus(root, t.number, TicketStatus.POSTPONED);
    expect(res.status).toBe(TicketStatus.POSTPONED);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.AccessDenied } })).toBeGreaterThanOrEqual(4);
  });

  it('удалённый админ становится обычным пользователем и сохраняет доступ к боту', async () => {
    const root = await makeUser(prisma, Role.SUPERADMIN);
    const admin = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(await makeUser(prisma), draft());

    const demoted = await env.c.users.disableAdmin(root, admin.id);

    expect(demoted.role).toBe(Role.USER);
    expect(demoted.isActive).toBe(true);
    await expect(env.c.adminTickets.accept(demoted, t.number)).rejects.toBeInstanceOf(ForbiddenError);
    const own = await env.c.tickets.create(demoted, draft());
    expect(own.userId).toBe(admin.id);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.AdminDisabled } })).toBe(1);
  });

  it('деактивированный админ теряет права', async () => {
    const user = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(user, draft());
    const disabled = await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } });
    await expect(env.c.adminTickets.accept(disabled, t.number)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('комментарии: INTERNAL не виден пользователю, USER — виден и приходит уведомлением', async () => {
    const user = await makeUser(prisma);
    const admin = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(user, draft());
    await env.c.adminTickets.accept(admin, t.number);

    await env.c.adminTickets.addComment(admin, t.number, 'секретная заметка', CommentVisibility.INTERNAL);
    await env.c.adminTickets.addComment(admin, t.number, 'открыт для вас', CommentVisibility.USER);

    const visible = await env.c.tickets.userVisibleComments(t.id);
    expect(visible.map((c) => c.text)).toEqual(['открыт для вас']);
    const texts = env.messenger.textsTo(user.maxUserId).join('\n');
    expect(texts).toContain('открыт для вас');
    expect(texts).not.toContain('секретная заметка');
  });

  it('передаёт заявку другому админу', async () => {
    const user = await makeUser(prisma);
    const a1 = await makeUser(prisma, Role.ADMIN);
    const a2 = await makeUser(prisma, Role.ADMIN);
    const t = await env.c.tickets.create(user, draft());
    await env.c.adminTickets.accept(a1, t.number);

    const moved = await env.c.adminTickets.transfer(a1, t.number, a2.id);

    expect(moved.assignedAdminId).toBe(a2.id);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.TicketTransferred } })).toBe(1);
    expect(env.messenger.textsTo(a2.maxUserId).some((s) => s.includes('передана заявка'))).toBe(true);
  });

  it('дедупликация webhook: одно событие обрабатывается один раз, даже при гонке', async () => {
    expect(await env.c.dedupe.claim('msg:abc')).toBe(true);
    expect(await env.c.dedupe.claim('msg:abc')).toBe(false);
    const results = await Promise.all(Array.from({ length: 10 }, () => env.c.dedupe.claim('cb:race')));
    expect(results.filter(Boolean)).toHaveLength(1);
    await env.c.dedupe.release('msg:abc');
    expect(await env.c.dedupe.claim('msg:abc')).toBe(true);
  });

  it('superadmin назначается по env, код активации одноразовый', async () => {
    const root = await env.c.users.ensureSuperadmin(777000n);
    expect(root.role).toBe(Role.SUPERADMIN);
    const newcomer = await makeUser(prisma);
    const { code } = await env.c.activation.createCode(root);
    const activated = await env.c.activation.activate(newcomer, code);
    expect(activated.role).toBe(Role.ADMIN);
    const second = await makeUser(prisma);
    await expect(env.c.activation.activate(second, code)).rejects.toBeInstanceOf(ConflictError);
    await expect(env.c.activation.createCode(newcomer)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
