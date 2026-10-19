import { TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { LIMITS } from '../config/constants';

export type QueueKind = 'new' | 'prog' | 'mine' | 'all';
export type UserListKind = 'active' | 'closed';
export type CommentKind = 'internal' | 'user';

/** Типизированный результат разбора payload кнопки. Всё, что не распознано, — `null`. */
export type CallbackAction =
  | { type: 'menu' }
  | { type: 'user_new' }
  | { type: 'user_branch'; branchId: number }
  | { type: 'user_send' }
  | { type: 'user_edit' }
  | { type: 'user_cancel' }
  | { type: 'user_list'; kind: UserListKind; page: number }
  | { type: 'ticket_open'; number: number }
  | { type: 'ticket_reply'; number: number }
  | { type: 'ticket_photos'; number: number }
  | { type: 'admin_queue'; kind: QueueKind; page: number }
  | { type: 'admin_find' }
  | { type: 'admin_accept'; number: number }
  | { type: 'admin_status_menu'; number: number }
  | { type: 'admin_status_set'; number: number; status: TicketStatus }
  | { type: 'admin_comment_menu'; number: number }
  | { type: 'admin_comment_start'; number: number; kind: CommentKind }
  | { type: 'admin_transfer_menu'; number: number }
  | { type: 'admin_transfer_to'; number: number; adminId: number }
  | { type: 'admin_history'; number: number }
  | { type: 'super_admins' }
  | { type: 'super_code' }
  | { type: 'super_disable'; adminId: number };

const int = (max: number) => z.coerce.number().int().min(0).max(max);
const id = int(LIMITS.TICKET_NUMBER_MAX);
const page = int(10_000);

const STATUS_CODES: Readonly<Record<string, TicketStatus>> = {
  ip: TicketStatus.IN_PROGRESS,
  wu: TicketStatus.WAITING_USER,
  pp: TicketStatus.POSTPONED,
  rs: TicketStatus.RESOLVED,
  cl: TicketStatus.CLOSED,
};
const CODE_BY_STATUS = Object.fromEntries(Object.entries(STATUS_CODES).map(([k, v]) => [v, k])) as Record<string, string>;

export const statusToCode = (s: TicketStatus): string => CODE_BY_STATUS[s] ?? '';

const QUEUES = new Set<string>(['new', 'prog', 'mine', 'all']);

export const cb = {
  menu: 'm',
  userNew: 'u:new',
  userBranch: (branchId: number) => `u:br:${branchId}`,
  userSend: 'u:send',
  userEdit: 'u:edit',
  userCancel: 'u:cancel',
  userList: (kind: UserListKind, p = 0) => `u:l:${kind === 'active' ? 'a' : 'c'}:${p}`,
  ticket: (n: number) => `t:${n}`,
  ticketReply: (n: number) => `t:rep:${n}`,
  ticketPhotos: (n: number) => `t:ph:${n}`,
  adminQueue: (kind: QueueKind, p = 0) => `a:q:${kind}:${p}`,
  adminFind: 'a:find',
  adminAccept: (n: number) => `a:acc:${n}`,
  adminStatusMenu: (n: number) => `a:st:${n}`,
  adminStatusSet: (n: number, s: TicketStatus) => `a:st:${n}:${statusToCode(s)}`,
  adminCommentMenu: (n: number) => `a:cm:${n}`,
  adminCommentStart: (n: number, k: CommentKind) => `a:cm:${n}:${k === 'internal' ? 'i' : 'u'}`,
  adminTransferMenu: (n: number) => `a:tr:${n}`,
  adminTransferTo: (n: number, adminId: number) => `a:tr:${n}:${adminId}`,
  adminHistory: (n: number) => `a:h:${n}`,
  superAdmins: 's:adm',
  superCode: 's:code',
  superDisable: (adminId: number) => `s:off:${adminId}`,
} as const;

export function parseCallback(payload: string | undefined | null): CallbackAction | null {
  if (!payload || payload.length > 64) return null;
  const p = payload.split(':');
  const num = (v: string | undefined, schema: z.ZodType<number>): number | null => {
    const r = schema.safeParse(v);
    return r.success ? r.data : null;
  };
  const [a, b, c, d] = p;

  switch (a) {
    case 'm':
      return p.length === 1 ? { type: 'menu' } : null;
    case 'u': {
      if (b === 'new' && p.length === 2) return { type: 'user_new' };
      if (b === 'send' && p.length === 2) return { type: 'user_send' };
      if (b === 'edit' && p.length === 2) return { type: 'user_edit' };
      if (b === 'cancel' && p.length === 2) return { type: 'user_cancel' };
      if (b === 'br' && p.length === 3) {
        const branchId = num(c, id);
        return branchId === null ? null : { type: 'user_branch', branchId };
      }
      if (b === 'l' && p.length === 4 && (c === 'a' || c === 'c')) {
        const pg = num(d, page);
        return pg === null ? null : { type: 'user_list', kind: c === 'a' ? 'active' : 'closed', page: pg };
      }
      return null;
    }
    case 't': {
      if (b === 'ph' && p.length === 3) {
        const n = num(c, id);
        return n === null ? null : { type: 'ticket_photos', number: n };
      }
      if (b === 'rep' && p.length === 3) {
        const n = num(c, id);
        return n === null ? null : { type: 'ticket_reply', number: n };
      }
      if (p.length === 2) {
        const n = num(b, id);
        return n === null ? null : { type: 'ticket_open', number: n };
      }
      return null;
    }
    case 'a': {
      if (b === 'find' && p.length === 2) return { type: 'admin_find' };
      if (b === 'q' && p.length === 4 && c && QUEUES.has(c)) {
        const pg = num(d, page);
        return pg === null ? null : { type: 'admin_queue', kind: c as QueueKind, page: pg };
      }
      const n = num(c, id);
      if (n === null) return null;
      if (b === 'acc' && p.length === 3) return { type: 'admin_accept', number: n };
      if (b === 'h' && p.length === 3) return { type: 'admin_history', number: n };
      if (b === 'st') {
        if (p.length === 3) return { type: 'admin_status_menu', number: n };
        const status = d ? STATUS_CODES[d] : undefined;
        return p.length === 4 && status ? { type: 'admin_status_set', number: n, status } : null;
      }
      if (b === 'cm') {
        if (p.length === 3) return { type: 'admin_comment_menu', number: n };
        if (p.length === 4 && (d === 'i' || d === 'u')) {
          return { type: 'admin_comment_start', number: n, kind: d === 'i' ? 'internal' : 'user' };
        }
        return null;
      }
      if (b === 'tr') {
        if (p.length === 3) return { type: 'admin_transfer_menu', number: n };
        const adminId = num(d, id);
        return p.length === 4 && adminId !== null ? { type: 'admin_transfer_to', number: n, adminId } : null;
      }
      return null;
    }
    case 's': {
      if (b === 'adm' && p.length === 2) return { type: 'super_admins' };
      if (b === 'code' && p.length === 2) return { type: 'super_code' };
      if (b === 'off' && p.length === 3) {
        const adminId = num(c, id);
        return adminId === null ? null : { type: 'super_disable', adminId };
      }
      return null;
    }
    default:
      return null;
  }
}
