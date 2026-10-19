import { ImageAttachment, Keyboard, type Api } from '@maxhub/max-bot-api';
import { MAX_API, LIMITS } from '../config/constants';
import type { KeyboardDef, Messenger, Screen } from '../types/messenger';
import type { Logger } from '../utils/logger';
import { sleep } from '../utils/sleep';
import { splitMessage } from '../utils/text';

export const toKeyboardAttachment = (keyboard: KeyboardDef) =>
  Keyboard.inlineKeyboard(keyboard.map((row) => row.map((b) => Keyboard.button.callback(b.text, b.payload))));

/** Вложения экрана: картинки (по token MAX) и клавиатура. */
export function screenAttachments(screen: Screen) {
  return [
    ...(screen.images ?? []).map((token) => new ImageAttachment({ token }).toJson()),
    ...(screen.keyboard ? [toKeyboardAttachment(screen.keyboard)] : []),
  ];
}

/** Отправка через официальный SDK: POST /messages. Соблюдает лимит 2 сообщения/с на диалог. */
export class MaxMessenger implements Messenger {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly api: Api,
    private readonly log: Logger,
  ) {}

  private async throttle(key: string): Promise<void> {
    const wait = (this.lastSent.get(key) ?? 0) + MAX_API.SEND_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSent.set(key, Date.now());
  }

  async sendToUser(maxUserId: bigint, screen: Screen): Promise<boolean> {
    const parts = splitMessage(screen.text, LIMITS.MAX_MESSAGE_LENGTH);
    const key = maxUserId.toString();
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const attachments = isLast ? screenAttachments(screen) : [];
      const extra = attachments.length > 0 ? { attachments } : {};
      if (!(await this.sendWithRetry(key, Number(maxUserId), parts[i] ?? '', extra))) return false;
    }
    return true;
  }

  private async sendWithRetry(key: string, userId: number, text: string, extra: Parameters<Api['sendMessageToUser']>[2]): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_API.SEND_RETRIES; attempt++) {
      try {
        await this.throttle(key);
        await this.api.sendMessageToUser(userId, text, extra);
        return true;
      } catch (err) {
        this.log.error({ err, attempt }, 'MAX sendMessage failed');
        await sleep(attempt * 1000);
      }
    }
    return false;
  }
}
