import type { User } from '@prisma/client';
import { LIMITS } from '../config/constants';
import { mainMenuKeyboard } from '../keyboards/menu.keyboard';
import { MSG } from '../messages/common.messages';
import { cb } from '../security/callback-data';
import { activationCodeSchema, parseInput } from '../security/input';
import type { ActivationService } from '../services/activation.service';
import type { UserService } from '../services/user.service';
import type { Responder } from '../bot/types';

export class SuperHandler {
  constructor(
    private readonly users: UserService,
    private readonly activation: ActivationService,
  ) {}

  async admins(actor: User, res: Responder): Promise<void> {
    const list = await this.users.listAdmins(actor);
    await res.show({
      text: ['Администраторы:', ...list.map((a) => `• ${a.displayName} — ${a.role}${a.isActive ? '' : ' (отключён)'}`)].join('\n'),
      keyboard: [
        ...list.filter((a) => a.role === 'ADMIN' && a.isActive).map((a) => [{ text: `🚫 Отключить: ${a.displayName}`, payload: cb.superDisable(a.id) }]),
        [{ text: '⬅️ В меню', payload: cb.menu }],
      ],
    });
  }

  async disable(actor: User, adminId: number, res: Responder): Promise<void> {
    await this.users.disableAdmin(actor, adminId);
    await this.admins(actor, res);
  }

  async createCode(actor: User, res: Responder): Promise<void> {
    const { code } = await this.activation.createCode(actor);
    await res.show({ text: MSG.codeCreated(code, LIMITS.ACTIVATION_CODE_TTL_HOURS), keyboard: [[{ text: '⬅️ В меню', payload: cb.menu }]] });
  }

  /** `/activate КОД`. Возвращает true, если сообщение с кодом стоит удалить. */
  async activate(user: User, rawCode: string, res: Responder): Promise<boolean> {
    if (!rawCode) {
      await res.show({ text: MSG.activateUsage });
      return false;
    }
    const code = parseInput(activationCodeSchema, rawCode);
    if (!code.ok) {
      await res.show({ text: code.error });
      return true;
    }
    const updated = await this.activation.activate(user, code.value);
    await res.show({ text: MSG.activated, keyboard: mainMenuKeyboard(updated) });
    return true;
  }
}
