import type { User } from '@prisma/client';
import { Permission, roleHasPermission } from '../domain/permissions';
import { cb, type StatsIndex, type StatsView } from '../security/callback-data';
import type { StatsService } from '../services/stats.service';
import { dailyText, overviewText, requestersText, staffText, weeklyText } from '../messages/stats.messages';
import type { Responder } from '../bot/types';
import type { KeyboardDef } from '../types/messenger';

const VIEW_BUTTONS: { view: StatsView; label: string; superOnly?: boolean }[] = [
  { view: 'overview', label: '📊 Сводка' },
  { view: 'days', label: '📅 По дням' },
  { view: 'weeks', label: '🗓 По неделям' },
  { view: 'staff', label: '👥 Сотрудники' },
  { view: 'users', label: '📨 Кто обращается', superOnly: true },
];

const PERIOD_LABELS: Record<StatsView, [string, string, string]> = {
  overview: ['Сегодня', '7 дней', '30 дней'],
  staff: ['Сегодня', '7 дней', '30 дней'],
  users: ['Сегодня', '7 дней', '30 дней'],
  days: ['7 дней', '14 дней', '30 дней'],
  weeks: ['4 недели', '8 недель', '12 недель'],
};

export class StatsHandler {
  constructor(private readonly stats: StatsService) {}

  menu(user: User, res: Responder): Promise<void> {
    return res.show({
      text: '📊 Статистика. Что показать?',
      keyboard: [
        ...VIEW_BUTTONS.filter((b) => !b.superOnly || roleHasPermission(user.role, Permission.ViewAllStats)).map((b) => [
          { text: b.label, payload: cb.adminStats(b.view, b.view === 'weeks' ? 1 : 2) },
        ]),
        [{ text: '⬅️ В меню', payload: cb.menu }],
      ],
    });
  }

  private keyboard(user: User, view: StatsView, idx: StatsIndex): KeyboardDef {
    const labels = PERIOD_LABELS[view];
    const periods = ([1, 2, 3] as const).map((i) => ({
      text: i === idx ? `● ${labels[i - 1]}` : (labels[i - 1] ?? ''),
      payload: cb.adminStats(view, i),
    }));
    const others = VIEW_BUTTONS.filter((b) => b.view !== view && (!b.superOnly || roleHasPermission(user.role, Permission.ViewAllStats))).map((b) => ({
      text: b.label,
      payload: cb.adminStats(b.view, b.view === 'weeks' ? 1 : 2),
    }));
    const rows: KeyboardDef = [periods];
    for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2));
    rows.push([{ text: '⬅️ В меню', payload: cb.menu }]);
    return rows;
  }

  async show(user: User, view: StatsView, idx: StatsIndex, res: Responder): Promise<void> {
    let text: string;
    switch (view) {
      case 'overview':
        text = overviewText(await this.stats.overview(user, idx));
        break;
      case 'days':
        text = dailyText(await this.stats.daily(user, idx));
        break;
      case 'weeks': {
        const w = await this.stats.weekly(user, idx);
        text = weeklyText(w.weeks, w.data);
        break;
      }
      case 'staff':
        text = staffText(await this.stats.staff(user, idx));
        break;
      case 'users':
        text = requestersText(await this.stats.requesters(user, idx));
        break;
    }
    await res.show({ text, keyboard: this.keyboard(user, view, idx) });
  }
}
