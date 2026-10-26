import { SessionState, type PrismaClient, type User } from '@prisma/client';
import { REPORT_TZ } from '../config/timezone';
import { MSG } from '../messages/common.messages';
import type { BranchRepository } from '../repositories/branch.repository';
import type { ArchiveFilter } from '../repositories/ticket.repository';
import { cb, type ArchivePeriod } from '../security/callback-data';
import { archiveQuerySchema, parseInput } from '../security/input';
import type { AdminTicketService } from '../services/admin-ticket.service';
import type { SessionService } from '../services/session.service';
import { addDays, localDay, shortDay, startOfLocalDay } from '../utils/dates';
import { truncate } from '../utils/text';
import type { Responder } from '../bot/types';
import type { KeyboardDef } from '../types/messenger';
import type { TicketWithRelations } from '../repositories/ticket.repository';

const PERIOD_LABEL: Record<ArchivePeriod, string> = { t: 'сегодня', w: '7 дней', m: '30 дней', a: 'всё время' };
const PERIOD_ORDER: ArchivePeriod[] = ['t', 'w', 'm', 'a'];
const PERIOD_BUTTON: Record<ArchivePeriod, string> = { t: 'Сегодня', w: '7 дней', m: '30 дней', a: 'Всё' };

const archiveLine = (t: TicketWithRelations): string => {
  const closed = t.closedAt ? shortDay(localDay(t.closedAt, REPORT_TZ)) : '—';
  return truncate(`#${t.number} · ${closed} · ${t.branch.name}, ${t.room}`, 60);
};

function sinceOf(period: ArchivePeriod, now = new Date()): Date | null {
  if (period === 'a') return null;
  const today = localDay(now, REPORT_TZ);
  const from = period === 't' ? today : addDays(today, period === 'w' ? -6 : -29);
  return startOfLocalDay(from, REPORT_TZ);
}

export class ArchiveHandler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly admin: AdminTicketService,
    private readonly sessions: SessionService,
    private readonly branches: BranchRepository,
  ) {}

  async show(user: User, period: ArchivePeriod, branchId: number, pageNo: number, useQuery: boolean, res: Responder): Promise<void> {
    const session = await this.sessions.get(user);
    const query = useQuery ? (session.draft.archiveQuery ?? null) : null;
    const branch = branchId > 0 ? (await this.branches.listActive(this.prisma)).find((b) => b.id === branchId) ?? null : null;
    const filter: ArchiveFilter = { since: sinceOf(period), branchId: branch ? branch.id : null, query };
    const page = await this.admin.archive(user, filter, pageNo);

    const hasQuery = query !== null;
    const head = [
      `🗄 Архив заявок: ${PERIOD_LABEL[period]}`,
      ...(branch ? [`Филиал: ${branch.name}`] : []),
      ...(hasQuery ? [`Поиск: «${query}»`] : useQuery ? ['(прежний поиск устарел)'] : []),
      `Найдено: ${page.total}`,
    ].join('\n');

    const qFlag = hasQuery;
    const bId = branch ? branch.id : 0;
    const rows: KeyboardDef = page.items.map((t) => [{ text: archiveLine(t), payload: cb.ticket(t.number) }]);
    const nav = [];
    if (page.page > 0) nav.push({ text: '◀️ Назад', payload: cb.adminArchive(period, bId, page.page - 1, qFlag) });
    if (page.page + 1 < page.pages) nav.push({ text: 'Вперёд ▶️', payload: cb.adminArchive(period, bId, page.page + 1, qFlag) });
    if (nav.length) rows.push(nav);
    rows.push(PERIOD_ORDER.map((p) => ({ text: p === period ? `● ${PERIOD_BUTTON[p]}` : PERIOD_BUTTON[p], payload: cb.adminArchive(p, bId, 0, qFlag) })));
    rows.push([
      { text: branch ? `🏥 ${truncate(branch.name, 18)}` : '🏥 Филиал', payload: cb.adminArchiveBranches(period, qFlag) },
      { text: '🔎 Поиск', payload: cb.adminArchiveSearch(period, bId) },
    ]);
    if (hasQuery || branch) rows.push([{ text: '✖️ Сбросить фильтры', payload: cb.adminArchive(period, 0, 0, false) }]);
    rows.push([{ text: '⬅️ В меню', payload: cb.menu }]);
    await res.show({ text: page.total === 0 ? `${head}\n\nЗаявок не найдено.` : head, keyboard: rows });
  }

  async pickBranch(user: User, period: ArchivePeriod, useQuery: boolean, res: Responder): Promise<void> {
    const branches = await this.branches.listActive(this.prisma);
    await res.show({
      text: 'Выберите филиал:',
      keyboard: [
        [{ text: 'Все филиалы', payload: cb.adminArchive(period, 0, 0, useQuery) }],
        ...branches.map((b) => [{ text: b.name, payload: cb.adminArchive(period, b.id, 0, useQuery) }]),
        [{ text: '⬅️ К архиву', payload: cb.adminArchive(period, 0, 0, useQuery) }],
      ],
    });
  }

  async startSearch(user: User, period: ArchivePeriod, branchId: number, res: Responder): Promise<void> {
    await this.sessions.set(user, SessionState.ENTER_ARCHIVE_QUERY, { archivePeriod: period, archiveBranch: branchId });
    await res.show({
      text: 'Введите, что искать: слово из описания, кабинет или имя автора.',
      keyboard: [[{ text: '✖️ Отмена', payload: cb.adminArchive(period, branchId, 0, false) }]],
    });
  }

  async onSearchText(user: User, text: string, res: Responder): Promise<void> {
    const session = await this.sessions.get(user);
    const period = session.draft.archivePeriod ?? 'a';
    const branchId = session.draft.archiveBranch ?? 0;
    const q = parseInput(archiveQuerySchema, text);
    if (!q.ok) {
      return res.show({ text: `${q.error}\n\n${MSG.archiveSearchPrompt}`, keyboard: [[{ text: '✖️ Отмена', payload: cb.adminArchive(period, branchId, 0, false) }]] });
    }
    // Запрос хранится в черновике сессии (состояние IDLE), чтобы листать страницы без повторного ввода.
    await this.sessions.set(user, SessionState.IDLE, { archiveQuery: q.value, archivePeriod: period, archiveBranch: branchId });
    await this.show(user, period, branchId, 0, true, res);
  }
}
