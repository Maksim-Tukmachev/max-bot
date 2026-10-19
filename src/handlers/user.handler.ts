import { SessionState, type User } from '@prisma/client';
import { LIMITS } from '../config/constants';
import type { PhotoRef } from '../security/input';
import { mainMenuKeyboard } from '../keyboards/menu.keyboard';
import { ticketListKeyboard } from '../keyboards/list.keyboard';
import { userTicketKeyboardFor } from '../keyboards/ticket-card.keyboard';
import { MSG } from '../messages/common.messages';
import { draftCard, userTicketCard } from '../messages/ticket.messages';
import type { BranchRepository } from '../repositories/branch.repository';
import { cb, type UserListKind } from '../security/callback-data';
import { descriptionSchema, parseInput, roomSchema } from '../security/input';
import type { SessionService } from '../services/session.service';
import type { TicketService } from '../services/ticket.service';
import type { Responder } from '../bot/types';
import type { Screen } from '../types/messenger';
import type { PrismaClient } from '@prisma/client';

const CANCEL_ROW = [{ text: '✖️ Отмена', payload: cb.userCancel }];

export class UserHandler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tickets: TicketService,
    private readonly sessions: SessionService,
    private readonly branches: BranchRepository,
  ) {}

  menuScreen(user: User): Screen {
    return { text: MSG.menuTitle(user.displayName), keyboard: mainMenuKeyboard(user) };
  }

  async showMenu(user: User, res: Responder): Promise<void> {
    await this.sessions.reset(user);
    await res.show(this.menuScreen(user));
  }

  async startCreate(user: User, res: Responder): Promise<void> {
    const branches = await this.branches.listActive(this.prisma);
    await this.sessions.set(user, SessionState.SELECT_BRANCH, {});
    await res.show({
      text: MSG.pickBranch,
      keyboard: [...branches.map((b) => [{ text: b.name, payload: cb.userBranch(b.id) }]), CANCEL_ROW],
    });
  }

  async selectBranch(user: User, branchId: number, res: Responder): Promise<void> {
    const session = await this.sessions.get(user);
    if (session.state !== SessionState.SELECT_BRANCH) return res.notify(MSG.invalidAction);
    const branch = await this.branches.findActiveById(this.prisma, branchId);
    if (!branch) return res.notify(MSG.invalidAction);
    await this.sessions.set(user, SessionState.ENTER_ROOM, { branchId: branch.id });
    await res.show({ text: `Филиал: ${branch.name}\n\n${MSG.askRoom}`, keyboard: [CANCEL_ROW] });
  }

  async onText(user: User, text: string, images: PhotoRef[], hasOtherMedia: boolean, res: Responder): Promise<boolean> {
    const session = await this.sessions.get(user);
    if (session.state === SessionState.ENTER_ROOM) {
      const room = parseInput(roomSchema, text);
      if (!room.ok) {
        await res.show({ text: `${room.error}\n\n${MSG.askRoom}`, keyboard: [CANCEL_ROW] });
        return true;
      }
      await this.sessions.set(user, SessionState.ENTER_DESCRIPTION, { ...session.draft, room: room.value });
      await res.show({ text: MSG.askDescription, keyboard: [CANCEL_ROW] });
      return true;
    }
    if (session.state === SessionState.ENTER_DESCRIPTION) {
      const known = session.draft.photos ?? [];
      const fresh = images.filter((i) => !known.some((k) => k.token === i.token));
      const photos = [...known, ...fresh].slice(0, LIMITS.MAX_PHOTOS);
      const overflow = known.length + fresh.length > LIMITS.MAX_PHOTOS;
      const draftWithPhotos = { ...session.draft, photos };
      if (!text) {
        // Только фото (или неподдерживаемое вложение) — копим и просим описание.
        await this.sessions.set(user, SessionState.ENTER_DESCRIPTION, draftWithPhotos);
        const notes = [photos.length > 0 ? MSG.photoAdded(photos.length) : MSG.askDescription];
        if (overflow) notes.push(MSG.photoLimit);
        if (hasOtherMedia) notes.push(MSG.onlyImages);
        await res.show({ text: notes.join('\n'), keyboard: [CANCEL_ROW] });
        return true;
      }
      const description = parseInput(descriptionSchema, text);
      if (!description.ok) {
        await this.sessions.set(user, SessionState.ENTER_DESCRIPTION, draftWithPhotos);
        await res.show({ text: `${description.error}\n\n${MSG.askDescription}`, keyboard: [CANCEL_ROW] });
        return true;
      }
      await this.sessions.set(user, SessionState.CONFIRM, { ...draftWithPhotos, description: description.value });
      await this.showConfirm(user, res);
      return true;
    }
    return false;
  }

  private async showConfirm(user: User, res: Responder): Promise<void> {
    const { draft } = await this.sessions.get(user);
    const branch = draft.branchId ? await this.branches.findActiveById(this.prisma, draft.branchId) : null;
    if (!branch || !draft.room || !draft.description) {
      await this.startCreate(user, res);
      return;
    }
    await res.show({
      text: draftCard(branch.name, draft.room, draft.description, draft.photos?.length ?? 0),
      keyboard: [
        [{ text: '📨 Отправить', payload: cb.userSend }],
        [
          { text: '✏️ Изменить', payload: cb.userEdit },
          { text: '✖️ Отмена', payload: cb.userCancel },
        ],
      ],
    });
  }

  async send(user: User, res: Responder): Promise<void> {
    const session = await this.sessions.get(user);
    const { branchId, room, description, photos } = session.draft;
    if (session.state !== SessionState.CONFIRM || !branchId || !room || !description) {
      return res.notify(MSG.invalidAction);
    }
    // Атомарный захват черновика: повторное или параллельное нажатие «Отправить» не создаст вторую заявку.
    if (!(await this.sessions.claimConfirm(user))) return res.notify(MSG.invalidAction);
    const ticket = await this.tickets.create(user, { branchId, room, description, photos });
    await res.show({ text: MSG.created(ticket.number), keyboard: [[{ text: '⬅️ В меню', payload: cb.menu }]] });
  }

  async edit(user: User, res: Responder): Promise<void> {
    const session = await this.sessions.get(user);
    if (session.state !== SessionState.CONFIRM) return res.notify(MSG.invalidAction);
    await this.startCreate(user, res);
  }

  async cancel(user: User, res: Responder): Promise<void> {
    await this.sessions.reset(user);
    await res.show({ text: MSG.cancelled, keyboard: mainMenuKeyboard(user) });
  }

  async list(user: User, kind: UserListKind, pageNo: number, res: Responder): Promise<void> {
    const page = await this.tickets.listForUser(user, kind, pageNo);
    if (page.total === 0) {
      return res.show({ text: MSG.noTickets, keyboard: [[{ text: '⬅️ В меню', payload: cb.menu }]] });
    }
    await res.show({
      text: kind === 'active' ? MSG.listActive(page.total) : MSG.listClosed(page.total),
      keyboard: ticketListKeyboard(page, (p) => cb.userList(kind, p)),
    });
  }

  async openOwnTicket(user: User, number: number, res: Responder): Promise<void> {
    const ticket = await this.tickets.getForViewer(user, number);
    const comments = await this.tickets.userVisibleComments(ticket.id);
    const tail = comments.slice(-5).map((c) => `💬 ${c.author.displayName}: ${c.text}`);
    await res.show({
      text: [userTicketCard(ticket), ...(tail.length ? ['', ...tail] : [])].join('\n'),
      keyboard: userTicketKeyboardFor(ticket),
    });
  }

  async showPhotos(user: User, number: number, res: Responder): Promise<void> {
    const tokens = await this.tickets.photosFor(user, number);
    if (tokens.length === 0) return res.notify(MSG.noPhotos);
    await res.show({
      text: `Фото к заявке #${number}`,
      images: tokens,
      keyboard: [[{ text: '⬅️ К заявке', payload: cb.ticket(number) }]],
    });
  }

  async startReply(user: User, number: number, res: Responder): Promise<void> {
    const ticket = await this.tickets.getForViewer(user, number);
    if (ticket.userId !== user.id) return res.notify(MSG.invalidAction);
    await this.sessions.set(user, SessionState.ENTER_COMMENT, { ticketNumber: number });
    await res.show({ text: MSG.askReply, keyboard: [[{ text: '✖️ Отмена', payload: cb.ticket(number) }]] });
  }

  async onReplyText(user: User, number: number, text: string, res: Responder): Promise<void> {
    await this.tickets.userReply(user, number, text);
    await this.sessions.reset(user);
    await res.show({ text: MSG.replySaved, keyboard: [[{ text: '⬅️ К заявке', payload: cb.ticket(number) }]] });
  }
}

export const PAGE_SIZE = LIMITS.PAGE_SIZE;
