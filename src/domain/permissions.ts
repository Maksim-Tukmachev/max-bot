import { Role } from '@prisma/client';

export enum Permission {
  CreateTicket = 'CREATE_TICKET',
  ViewQueue = 'VIEW_QUEUE',
  AcceptTicket = 'ACCEPT_TICKET',
  ChangeStatus = 'CHANGE_STATUS',
  CommentTicket = 'COMMENT_TICKET',
  TransferTicket = 'TRANSFER_TICKET',
  ViewAnyTicket = 'VIEW_ANY_TICKET',
  ManageAdmins = 'MANAGE_ADMINS',
}

const USER_PERMISSIONS: readonly Permission[] = [Permission.CreateTicket];
const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...USER_PERMISSIONS,
  Permission.ViewQueue,
  Permission.AcceptTicket,
  Permission.ChangeStatus,
  Permission.CommentTicket,
  Permission.TransferTicket,
  Permission.ViewAnyTicket,
];

const BY_ROLE: Readonly<Record<Role, readonly Permission[]>> = {
  USER: USER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  SUPERADMIN: [...ADMIN_PERMISSIONS, Permission.ManageAdmins],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return BY_ROLE[role].includes(permission);
}

export const isAdminRole = (role: Role): boolean => role === Role.ADMIN || role === Role.SUPERADMIN;
