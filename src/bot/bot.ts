import type { Bot, Context } from '@maxhub/max-bot-api';
import type { User } from '@prisma/client';
import { AuditAction, AuditEntity } from '../domain/enums';
import { MSG } from '../messages/common.messages';
import type { UserRateLimiter } from '../middleware/user-rate-limit';
import type { AuditService } from '../services/audit.service';
import type { UserService } from '../services/user.service';
import type { WebhookDedupeService } from '../services/webhook-dedupe.service';
import type { PhotoRef } from '../security/input';
import type { Screen } from '../types/messenger';
import type { Logger } from '../utils/logger';
import { screenAttachments } from './max-messenger';
import type { UpdateRouter, Incoming } from './update-router';
import type { Responder } from './types';

type MaxUser = { user_id: number; first_name?: string; last_name?: string; name?: string; is_bot?: boolean };

const displayNameOf = (u: MaxUser): string =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || `user ${u.user_id}`;

export interface BotDeps {
  router: UpdateRouter;
  users: UserService;
  dedupe: WebhookDedupeService;
  audit: AuditService;
  limiter: UserRateLimiter;
  log: Logger;
}

function buildResponder(ctx: Context, isCallback: boolean): Responder {
  let answered = false;
  const extraOf = (screen: Screen) => {
    const attachments = screenAttachments(screen);
    return attachments.length > 0 ? { attachments } : {};
  };
  return {
    async show(screen) {
      if (isCallback && !answered) {
        answered = true;
        try {
          await ctx.answerOnCallback({ message: { text: screen.text, ...extraOf(screen) } });
          return;
        } catch {
          // сообщение могло устареть — отправляем новым
        }
      }
      await ctx.reply(screen.text, extraOf(screen));
    },
    async notify(text) {
      if (isCallback && !answered) {
        answered = true;
        try {
          await ctx.answerOnCallback({ notification: text });
          return;
        } catch {
          /* fallthrough */
        }
      }
      await ctx.reply(text);
    },
  };
}

/** Подключает единый middleware: дедупликация → rate limit → пользователь → роутер. */
export function registerBot(bot: Bot, deps: BotDeps): void {
  const { router, users, dedupe, audit, limiter, log } = deps;

  bot.use(async (ctx) => {
    const update = ctx.update;
    let eventId: string;
    let maxUser: MaxUser | null | undefined;
    let build: ((user: User) => Incoming) | null = null;
    let isCallback = false;
    let myIdText = false;

    switch (update.update_type) {
      case 'bot_started':
        eventId = `start:${update.user.user_id}:${update.timestamp}`;
        maxUser = update.user;
        build = (user) => ({ kind: 'start', user });
        break;
      case 'message_created': {
        const msg = update.message;
        if (msg.recipient.chat_type !== 'dialog') return; // работаем только в личных диалогах
        eventId = `msg:${msg.body.mid}`;
        maxUser = msg.sender;
        const text = msg.body.text?.trim() ?? '';
        const attachments = msg.body.attachments ?? [];
        const images: PhotoRef[] = attachments.flatMap((a) =>
          a.type === 'image' ? [{ token: a.payload.token, photoId: a.payload.photo_id }] : [],
        );
        const hasOtherMedia = attachments.some((a) => a.type !== 'image' && a.type !== 'inline_keyboard');
        if (!text && images.length === 0 && !hasOtherMedia) return;
        myIdText = text.toLowerCase() === '/myid';
        build = (user) => ({ kind: 'text', user, text, images, hasOtherMedia });
        break;
      }
      case 'message_callback':
        eventId = `cb:${update.callback.callback_id}`;
        maxUser = update.callback.user;
        isCallback = true;
        build = (user) => ({ kind: 'callback', user, payload: update.callback.payload });
        break;
      default:
        return; // остальные типы событий не используются
    }

    if (!maxUser || maxUser.is_bot) return;
    log.info({ updateType: update.update_type, eventId }, 'update received');

    if (!(await dedupe.claim(eventId))) {
      log.info({ eventId }, 'duplicate update skipped');
      return;
    }

    try {
      const responder = buildResponder(ctx, isCallback);

      if (myIdText) {
        await ctx.reply(MSG.myId(maxUser.user_id, ctx.chatId ?? undefined));
        return;
      }
      if (!limiter.allow(String(maxUser.user_id))) {
        await responder.notify(MSG.tooManyRequests);
        return;
      }

      const user = await users.touch(BigInt(maxUser.user_id), displayNameOf(maxUser));
      if (!user.isActive) {
        await audit.recordStandalone({
          actorId: user.id,
          action: AuditAction.AccessDenied,
          entityType: AuditEntity.User,
          entityId: user.id,
          metadata: { reason: 'inactive' },
        });
        await responder.notify(MSG.accessDisabled);
        return;
      }

      const result = await router.handle(build(user), responder);
      if (result.deleteSourceMessage && update.update_type === 'message_created') {
        await ctx.deleteMessage(update.message.body.mid).catch(() => undefined);
      }
    } catch (err) {
      // Обработка не дошла до результата — снимаем отметку, чтобы повторная доставка сработала.
      await dedupe.release(eventId).catch(() => undefined);
      log.error({ err, eventId }, 'update processing failed');
    }
  });

}
