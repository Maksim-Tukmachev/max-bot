import type { PrismaClient, User } from '@prisma/client';
import { REPORT_TZ } from '../config/timezone';
import { Permission } from '../domain/permissions';
import {
  StatsRepository,
  type DateRange,
  type DayRow,
  type EmployeeRow,
  type Overview,
  type RequesterRow,
  type WeekRow,
} from '../repositories/stats.repository';
import { addDays, localDay } from '../utils/dates';
import type { PermissionService } from './permission.service';

/** Индекс периода кнопки: 1..3. Для обзора и сотрудников — сегодня/7/30 дней; для «по дням» — 7/14/30; для «по неделям» — 4/8/12. */
export type PeriodIndex = 1 | 2 | 3;

const SUMMARY_DAYS: Record<PeriodIndex, number> = { 1: 1, 2: 7, 3: 30 };
const DAILY_DAYS: Record<PeriodIndex, number> = { 1: 7, 2: 14, 3: 30 };
const WEEKLY_WEEKS: Record<PeriodIndex, number> = { 1: 4, 2: 8, 3: 12 };
const TOP_REQUESTERS = 10;

export interface Ranged<T> {
  range: DateRange;
  days: number;
  data: T;
}

export class StatsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: StatsRepository,
    private readonly permissions: PermissionService,
    private readonly tz: string = REPORT_TZ,
  ) {}

  private today(now: Date): string {
    return localDay(now, this.tz);
  }

  private rangeOf(days: number, now: Date): DateRange {
    const today = this.today(now);
    return { fromDay: addDays(today, -(days - 1)), toDay: addDays(today, 1) };
  }

  async overview(actor: User, idx: PeriodIndex, now = new Date()): Promise<Ranged<Overview>> {
    await this.permissions.require(actor, Permission.ViewStats);
    const days = SUMMARY_DAYS[idx];
    const range = this.rangeOf(days, now);
    return { range, days, data: await this.repo.overview(this.prisma, range, this.tz) };
  }

  async daily(actor: User, idx: PeriodIndex, now = new Date()): Promise<Ranged<DayRow[]>> {
    await this.permissions.require(actor, Permission.ViewStats);
    const days = DAILY_DAYS[idx];
    const range = this.rangeOf(days, now);
    return { range, days, data: await this.repo.byDay(this.prisma, range, this.tz) };
  }

  async weekly(actor: User, idx: PeriodIndex, now = new Date()): Promise<{ weeks: number; data: WeekRow[] }> {
    await this.permissions.require(actor, Permission.ViewStats);
    const weeks = WEEKLY_WEEKS[idx];
    return { weeks, data: await this.repo.byWeek(this.prisma, weeks, this.today(now), this.tz) };
  }

  /** Superadmin видит всех исполнителей, обычный администратор — только свою строку. */
  async staff(actor: User, idx: PeriodIndex, now = new Date()): Promise<Ranged<EmployeeRow[]> & { onlyOwn: boolean }> {
    await this.permissions.require(actor, Permission.ViewStats);
    const days = SUMMARY_DAYS[idx];
    const range = this.rangeOf(days, now);
    const onlyOwn = !this.permissions.can(actor, Permission.ViewAllStats);
    const data = await this.repo.employees(this.prisma, range, this.tz, onlyOwn ? actor.id : null);
    return { range, days, data, onlyOwn };
  }

  async requesters(actor: User, idx: PeriodIndex, now = new Date()): Promise<Ranged<RequesterRow[]>> {
    await this.permissions.require(actor, Permission.ViewAllStats);
    const days = SUMMARY_DAYS[idx];
    const range = this.rangeOf(days, now);
    return { range, days, data: await this.repo.topRequesters(this.prisma, range, this.tz, TOP_REQUESTERS) };
  }
}
