import { TicketStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { Permission, roleHasPermission } from '../../src/domain/permissions';
import { canTransition } from '../../src/domain/ticket-transitions';
import { UserRateLimiter } from '../../src/middleware/user-rate-limit';
import { commentSchema, parseInput, roomSchema } from '../../src/security/input';
import { splitMessage } from '../../src/utils/text';

describe('permissions', () => {
  it('USER не имеет админских прав, SUPERADMIN управляет админами', () => {
    expect(roleHasPermission('USER', Permission.AcceptTicket)).toBe(false);
    expect(roleHasPermission('ADMIN', Permission.AcceptTicket)).toBe(true);
    expect(roleHasPermission('ADMIN', Permission.ManageAdmins)).toBe(false);
    expect(roleHasPermission('SUPERADMIN', Permission.ManageAdmins)).toBe(true);
  });
});

describe('ticket transitions', () => {
  it('NEW можно только принять, CLOSED — финальный', () => {
    expect(canTransition(TicketStatus.NEW, TicketStatus.IN_PROGRESS)).toBe(true);
    expect(canTransition(TicketStatus.NEW, TicketStatus.CLOSED)).toBe(false);
    expect(canTransition(TicketStatus.CLOSED, TicketStatus.IN_PROGRESS)).toBe(false);
    expect(canTransition(TicketStatus.RESOLVED, TicketStatus.IN_PROGRESS)).toBe(true);
  });
});

describe('input validation', () => {
  it('отвергает пустые и слишком длинные значения', () => {
    expect(parseInput(roomSchema, '   ').ok).toBe(false);
    expect(parseInput(roomSchema, 'x'.repeat(101)).ok).toBe(false);
    expect(parseInput(commentSchema, 'x'.repeat(2001)).ok).toBe(false);
    expect(parseInput(roomSchema, ' 12  каб ')).toEqual({ ok: true, value: '12 каб' });
  });
  it('splitMessage режет длинный текст на части ≤ лимита', () => {
    const parts = splitMessage('a'.repeat(9000), 4000);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
    expect(parts.join('').length).toBe(9000);
  });
});

describe('rate limiter', () => {
  it('ограничивает число действий в окне', () => {
    const l = new UserRateLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => l.allow('u', 0))).toEqual([true, true, true, false]);
    expect(l.allow('u', 2000)).toBe(true);
  });
});

describe('env', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@db/x', MAX_BOT_TOKEN: 'token-token-token' };
  it('polling по умолчанию, webhook требует домен и секрет', () => {
    expect(loadEnv(base).MAX_MODE).toBe('polling');
    expect(() => loadEnv({ ...base, MAX_MODE: 'webhook' })).toThrow(/MAX_WEBHOOK/);
    expect(() => loadEnv({ ...base, MAX_MODE: 'webhook', MAX_WEBHOOK_DOMAIN: 'a.ru', MAX_WEBHOOK_SECRET: 'bad secret!' })).toThrow();
  });
  it('пустые значения в .env считаются незаданными', () => {
    const env = loadEnv({ ...base, MAX_WEBHOOK_SECRET: '', MAX_WEBHOOK_DOMAIN: '', SUPERADMIN_MAX_USER_ID: '' });
    expect(env.MAX_WEBHOOK_SECRET).toBeUndefined();
    expect(env.MAX_MODE).toBe('polling');
  });
  it('не раскрывает значения в сообщении об ошибке', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://u:SECRETPASS@db/x', MAX_BOT_TOKEN: 'short' })).toThrow(/MAX_BOT_TOKEN/);
    try {
      loadEnv({ DATABASE_URL: 'postgresql://u:SECRETPASS@db/x', MAX_BOT_TOKEN: 'short' });
    } catch (e) {
      expect(String(e)).not.toContain('SECRETPASS');
    }
  });
});
