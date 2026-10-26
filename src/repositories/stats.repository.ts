import { Prisma } from '@prisma/client';
import type { Db } from '../utils/prisma';

export interface DateRange {
  /** Первый день периода, включительно (YYYY-MM-DD в часовом поясе отчётов). */
  fromDay: string;
  /** День после последнего (исключительно). */
  toDay: string;
}

export interface Overview {
  created: number;
  closed: number;
  avgAcceptSeconds: number | null;
  avgCloseSeconds: number | null;
  current: Record<string, number>;
  byBranch: { name: string; count: number }[];
}

export interface DayRow {
  day: string;
  created: number;
  closed: number;
}

export interface WeekRow {
  weekStart: string;
  created: number;
  closed: number;
}

export interface EmployeeRow {
  adminId: number;
  name: string;
  accepted: number;
  avgAcceptSeconds: number | null;
  done: number;
  avgDoneSeconds: number | null;
  load: number;
}

export interface RequesterRow {
  name: string;
  count: number;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Только параметризованные запросы (Prisma.sql): значения никогда не склеиваются со строкой SQL. */
export class StatsRepository {
  private bounds(range: DateRange, tz: string) {
    return {
      from: Prisma.sql`((${range.fromDay}::date)::timestamp AT TIME ZONE ${tz}::text)`,
      to: Prisma.sql`((${range.toDay}::date)::timestamp AT TIME ZONE ${tz}::text)`,
    };
  }

  async overview(db: Db, range: DateRange, tz: string): Promise<Overview> {
    const { from, to } = this.bounds(range, tz);
    const [row] = await db.$queryRaw<
      { created: bigint; closed: bigint; avg_accept: number | null; avg_close: number | null }[]
    >(Prisma.sql`
      SELECT
        (SELECT count(*) FROM "Ticket" WHERE ("createdAt" AT TIME ZONE 'UTC') >= ${from} AND ("createdAt" AT TIME ZONE 'UTC') < ${to}) AS created,
        (SELECT count(*) FROM "Ticket" WHERE ("closedAt" AT TIME ZONE 'UTC') >= ${from} AND ("closedAt" AT TIME ZONE 'UTC') < ${to}) AS closed,
        (SELECT avg(extract(epoch FROM ("acceptedAt" - "createdAt"))) FROM "Ticket"
           WHERE ("createdAt" AT TIME ZONE 'UTC') >= ${from} AND ("createdAt" AT TIME ZONE 'UTC') < ${to} AND "acceptedAt" IS NOT NULL) AS avg_accept,
        (SELECT avg(extract(epoch FROM ("closedAt" - "createdAt"))) FROM "Ticket"
           WHERE ("closedAt" AT TIME ZONE 'UTC') >= ${from} AND ("closedAt" AT TIME ZONE 'UTC') < ${to}) AS avg_close`);
    const current = await db.$queryRaw<{ status: string; n: bigint }[]>(
      Prisma.sql`SELECT status::text AS status, count(*) AS n FROM "Ticket" GROUP BY status`,
    );
    const branches = await db.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT b.name, count(*) AS n FROM "Ticket" t JOIN "Branch" b ON b.id = t."branchId"
      WHERE (t."createdAt" AT TIME ZONE 'UTC') >= ${from} AND (t."createdAt" AT TIME ZONE 'UTC') < ${to}
      GROUP BY b.name ORDER BY n DESC, b.name`);
    return {
      created: num(row?.created),
      closed: num(row?.closed),
      avgAcceptSeconds: numOrNull(row?.avg_accept),
      avgCloseSeconds: numOrNull(row?.avg_close),
      current: Object.fromEntries(current.map((r) => [r.status, num(r.n)])),
      byBranch: branches.map((r) => ({ name: r.name, count: num(r.n) })),
    };
  }

  async byDay(db: Db, range: DateRange, tz: string): Promise<DayRow[]> {
    const lastDay = Prisma.sql`(${range.toDay}::date - 1)`;
    const rows = await db.$queryRaw<{ day: string; created: bigint; closed: bigint }[]>(Prisma.sql`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
        (SELECT count(*) FROM "Ticket" t
           WHERE ((t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date = d::date) AS created,
        (SELECT count(*) FROM "Ticket" t
           WHERE t."closedAt" IS NOT NULL AND ((t."closedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date = d::date) AS closed
      FROM generate_series(${range.fromDay}::date, ${lastDay}, interval '1 day') AS d
      ORDER BY d`);
    return rows.map((r) => ({ day: r.day, created: num(r.created), closed: num(r.closed) }));
  }

  async byWeek(db: Db, weeks: number, todayDay: string, tz: string): Promise<WeekRow[]> {
    const rows = await db.$queryRaw<{ week_start: string; created: bigint; closed: bigint }[]>(Prisma.sql`
      SELECT to_char(w::date, 'YYYY-MM-DD') AS week_start,
        (SELECT count(*) FROM "Ticket" t
           WHERE date_trunc('week', (t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date = w::date) AS created,
        (SELECT count(*) FROM "Ticket" t
           WHERE t."closedAt" IS NOT NULL AND date_trunc('week', (t."closedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)::date = w::date) AS closed
      FROM generate_series(
        date_trunc('week', ${todayDay}::date) - ((${weeks}::int - 1) * interval '1 week'),
        date_trunc('week', ${todayDay}::date),
        interval '1 week') AS w
      ORDER BY w`);
    return rows.map((r) => ({ weekStart: r.week_start, created: num(r.created), closed: num(r.closed) }));
  }

  /**
   * Сотрудники-исполнители. «Принял» — смена NEW→IN_PROGRESS в истории; «выполнил» — первый перевод заявки
   * в RESOLVED/CLOSED (одна заявка засчитывается одному человеку один раз). Время считается от создания заявки.
   */
  async employees(db: Db, range: DateRange, tz: string, onlyAdminId: number | null): Promise<EmployeeRow[]> {
    const { from, to } = this.bounds(range, tz);
    const rows = await db.$queryRaw<
      { id: number; name: string; accepted: bigint; avg_accept: number | null; done: bigint; avg_done: number | null; load: bigint }[]
    >(Prisma.sql`
      WITH accepted AS (
        SELECT h."changedBy" AS admin_id, count(*) AS n,
               avg(extract(epoch FROM (h."createdAt" - t."createdAt"))) AS avg_s
        FROM "TicketStatusHistory" h JOIN "Ticket" t ON t.id = h."ticketId"
        WHERE h."oldStatus" = 'NEW' AND h."newStatus" = 'IN_PROGRESS'
          AND (h."createdAt" AT TIME ZONE 'UTC') >= ${from} AND (h."createdAt" AT TIME ZONE 'UTC') < ${to}
        GROUP BY h."changedBy"
      ),
      first_done AS (
        SELECT DISTINCT ON (h."ticketId") h."ticketId", h."changedBy", h."createdAt" AS done_at, t."createdAt" AS ticket_created
        FROM "TicketStatusHistory" h JOIN "Ticket" t ON t.id = h."ticketId"
        WHERE h."newStatus" IN ('RESOLVED', 'CLOSED')
        ORDER BY h."ticketId", h."createdAt"
      ),
      done AS (
        SELECT "changedBy" AS admin_id, count(*) AS n,
               avg(extract(epoch FROM (done_at - ticket_created))) AS avg_s
        FROM first_done WHERE (done_at AT TIME ZONE 'UTC') >= ${from} AND (done_at AT TIME ZONE 'UTC') < ${to}
        GROUP BY "changedBy"
      ),
      load AS (
        SELECT "assignedAdminId" AS admin_id, count(*) AS n FROM "Ticket"
        WHERE status IN ('IN_PROGRESS', 'WAITING_USER', 'POSTPONED') AND "assignedAdminId" IS NOT NULL
        GROUP BY "assignedAdminId"
      )
      SELECT u.id, u."displayName" AS name,
             COALESCE(a.n, 0) AS accepted, a.avg_s AS avg_accept,
             COALESCE(d.n, 0) AS done, d.avg_s AS avg_done,
             COALESCE(l.n, 0) AS load
      FROM "User" u
      LEFT JOIN accepted a ON a.admin_id = u.id
      LEFT JOIN done d ON d.admin_id = u.id
      LEFT JOIN load l ON l.admin_id = u.id
      WHERE (u.role IN ('ADMIN', 'SUPERADMIN') OR a.n IS NOT NULL OR d.n IS NOT NULL OR l.n IS NOT NULL)
        AND (${onlyAdminId}::int IS NULL OR u.id = ${onlyAdminId}::int)
      ORDER BY COALESCE(d.n, 0) DESC, COALESCE(a.n, 0) DESC, u."displayName"`);
    return rows.map((r) => ({
      adminId: r.id,
      name: r.name,
      accepted: num(r.accepted),
      avgAcceptSeconds: numOrNull(r.avg_accept),
      done: num(r.done),
      avgDoneSeconds: numOrNull(r.avg_done),
      load: num(r.load),
    }));
  }

  async topRequesters(db: Db, range: DateRange, tz: string, limit: number): Promise<RequesterRow[]> {
    const { from, to } = this.bounds(range, tz);
    const rows = await db.$queryRaw<{ name: string; n: bigint }[]>(Prisma.sql`
      SELECT u."displayName" AS name, count(*) AS n
      FROM "Ticket" t JOIN "User" u ON u.id = t."userId"
      WHERE (t."createdAt" AT TIME ZONE 'UTC') >= ${from} AND (t."createdAt" AT TIME ZONE 'UTC') < ${to}
      GROUP BY u.id, u."displayName" ORDER BY n DESC, u."displayName" LIMIT ${limit}::int`);
    return rows.map((r) => ({ name: r.name, count: num(r.n) }));
  }
}
