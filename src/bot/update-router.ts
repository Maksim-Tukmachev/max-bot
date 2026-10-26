import { SessionState, type User } from '@prisma/client';
import { isAdminRole } from '../domain/permissions';
import { MSG } from '../messages/common.messages';
import { parseCallback, type CallbackAction } from '../security/callback-data';
import type { PermissionService } from '../services/permission.service';
import type { SessionService } from '../services/session.service';
import type { AdminHandler } from '../handlers/admin.handler';
import type { ArchiveHandler } from '../handlers/archive.handler';
import type { StatsHandler } from '../handlers/stats.handler';
import type { SuperHandler } from '../handlers/super.handler';
import type { UserHandler } from '../handlers/user.handler';
import { AppError, ForbiddenError, GENERIC_ERROR_MESSAGE } from '../utils/errors';
import type { PhotoRef } from '../security/input';
import type { Logger } from '../utils/logger';
import type { Responder } from './types';
import { Permission } from '../domain/permissions';

export type Incoming =
  | { kind: 'start'; user: User }
  | { kind: 'text'; user: User; text: string; images?: PhotoRef[]; hasOtherMedia?: boolean }
  | { kind: 'callback'; user: User; payload: string | undefined };

export interface HandleResult {
  /** Сообщение пользователя содержит секрет (код активации) и должно быть удалено. */
  deleteSourceMessage: boolean;
}

export class UpdateRouter {
  constructor(
    private readonly users: UserHandler,
    private readonly admin: AdminHandler,
    private readonly superH: SuperHandler,
    private readonly stats: StatsHandler,
    private readonly archive: ArchiveHandler,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionService,
    private readonly log: Logger,
  ) {}

  async handle(incoming: Incoming, res: Responder): Promise<HandleResult> {
    const result: HandleResult = { deleteSourceMessage: false };
    try {
      switch (incoming.kind) {
        case 'start':
          await this.users.showMenu(incoming.user, res);
          break;
        case 'callback':
          await this.onCallback(incoming.user, parseCallback(incoming.payload), res);
          break;
        case 'text':
          result.deleteSourceMessage = await this.onText(incoming.user, incoming.text, incoming.images ?? [], Boolean(incoming.hasOtherMedia), res);
          break;
      }
    } catch (err) {
      if (err instanceof AppError) {
        this.log.warn({ userId: incoming.user.id, error: err.name, detail: err.message }, 'handled app error');
        await res.notify(err.userMessage);
      } else {
        this.log.error({ err, userId: incoming.user.id }, 'unhandled error in router');
        await res.notify(GENERIC_ERROR_MESSAGE);
      }
    }
    return result;
  }

  /** Требует роль администратора на уровне роутера; детальные права проверяют сервисы. */
  private async guardAdmin(user: User): Promise<boolean> {
    if (isAdminRole(user.role) && user.isActive) return true;
    await this.permissions.require(user, Permission.ViewQueue, { via: 'callback' });
    return false;
  }

  private async onCallback(user: User, action: CallbackAction | null, res: Responder): Promise<void> {
    if (!action) return res.notify(MSG.invalidAction);
    switch (action.type) {
      case 'menu':
        return this.users.showMenu(user, res);
      case 'user_new':
        return this.users.startCreate(user, res);
      case 'user_branch':
        return this.users.selectBranch(user, action.branchId, res);
      case 'user_send':
        return this.users.send(user, res);
      case 'user_edit':
        return this.users.edit(user, res);
      case 'user_cancel':
        return this.users.cancel(user, res);
      case 'user_list':
        return this.users.list(user, action.kind, action.page, res);
      case 'ticket_open':
        // Сохраняем «спокойный» черновик (например, поисковый запрос архива); сбрасываем только ожидание ввода.
        if ((await this.sessions.get(user)).state !== SessionState.IDLE) await this.sessions.reset(user);
        return isAdminRole(user.role) ? this.admin.open(user, action.number, res) : this.users.openOwnTicket(user, action.number, res);
      case 'ticket_reply':
        return this.users.startReply(user, action.number, res);
      case 'ticket_photos':
        return this.users.showPhotos(user, action.number, res);
      case 'super_admins':
        return this.superH.admins(user, res);
      case 'super_code':
        return this.superH.createCode(user, res);
      case 'super_disable':
        return this.superH.disable(user, action.adminId, res);
      default:
        break;
    }
    // Всё остальное — административные действия.
    if (!(await this.guardAdmin(user))) throw new ForbiddenError(`non-admin callback ${action.type}`);
    switch (action.type) {
      case 'admin_queue':
        return this.admin.queue(user, action.kind, action.page, res);
      case 'admin_find':
        return this.admin.startFind(user, res);
      case 'admin_stats_menu':
        return this.stats.menu(user, res);
      case 'admin_stats':
        return this.stats.show(user, action.view, action.idx, res);
      case 'admin_archive':
        return this.archive.show(user, action.period, action.branchId, action.page, action.useQuery, res);
      case 'admin_archive_branches':
        return this.archive.pickBranch(user, action.period, action.useQuery, res);
      case 'admin_archive_search':
        return this.archive.startSearch(user, action.period, action.branchId, res);
      case 'admin_accept':
        return this.admin.accept(user, action.number, res);
      case 'admin_status_menu':
        return this.admin.statusMenu(user, action.number, res);
      case 'admin_status_set':
        return this.admin.setStatus(user, action.number, action.status, res);
      case 'admin_comment_menu':
        return this.admin.commentMenu(user, action.number, res);
      case 'admin_comment_start':
        return this.admin.commentStart(user, action.number, action.kind, res);
      case 'admin_transfer_menu':
        return this.admin.transferMenu(user, action.number, res);
      case 'admin_transfer_to':
        return this.admin.transferTo(user, action.number, action.adminId, res);
      case 'admin_history':
        return this.admin.history(user, action.number, res);
      default:
        return res.notify(MSG.invalidAction);
    }
  }

  private async onText(user: User, rawText: string, images: PhotoRef[], hasOtherMedia: boolean, res: Responder): Promise<boolean> {
    const text = rawText.trim();
    if (text.startsWith('/')) {
      const [command = '', ...rest] = text.split(/\s+/);
      switch (command.toLowerCase()) {
        case '/activate':
          return this.superH.activate(user, rest.join(''), res);
        default:
          await this.users.showMenu(user, res);
          return false;
      }
    }

    const session = await this.sessions.get(user);
    const { ticketNumber, commentKind } = session.draft;
    if (session.state === SessionState.ENTER_COMMENT && ticketNumber) {
      if (commentKind) {
        if (!(await this.guardAdmin(user))) return false;
        await this.admin.onCommentText(user, ticketNumber, commentKind, text, res);
      } else {
        await this.users.onReplyText(user, ticketNumber, text, res);
      }
      return false;
    }
    if (session.state === SessionState.ENTER_ARCHIVE_QUERY) {
      if (!(await this.guardAdmin(user))) return false;
      await this.archive.onSearchText(user, text, res);
      return false;
    }
    if (session.state === SessionState.ENTER_TICKET_NUMBER) {
      if (!(await this.guardAdmin(user))) return false;
      await this.admin.onFindText(user, text, res);
      return false;
    }
    if (!(await this.users.onText(user, text, images, hasOtherMedia, res))) {
      await this.users.showMenu(user, res);
    }
    return false;
  }
}
