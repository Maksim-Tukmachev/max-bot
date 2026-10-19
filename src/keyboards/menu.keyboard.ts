import { Role, type User } from '@prisma/client';
import { isAdminRole } from '../domain/permissions';
import { cb } from '../security/callback-data';
import type { KeyboardDef } from '../types/messenger';

export function mainMenuKeyboard(user: User): KeyboardDef {
  const rows: KeyboardDef = [
    [{ text: '📝 Создать заявку', payload: cb.userNew }],
    [
      { text: '📂 Мои активные', payload: cb.userList('active') },
      { text: '🗄 Закрытые', payload: cb.userList('closed') },
    ],
  ];
  if (isAdminRole(user.role)) {
    rows.push(
      [
        { text: '🆕 Новые заявки', payload: cb.adminQueue('new') },
        { text: '🔧 В работе', payload: cb.adminQueue('prog') },
      ],
      [
        { text: '👤 Мои заявки', payload: cb.adminQueue('mine') },
        { text: '📋 Все заявки', payload: cb.adminQueue('all') },
      ],
      [{ text: '🔎 Найти заявку', payload: cb.adminFind }],
    );
  }
  if (user.role === Role.SUPERADMIN) {
    rows.push([
      { text: '👥 Администраторы', payload: cb.superAdmins },
      { text: '🔑 Код активации', payload: cb.superCode },
    ]);
  }
  return rows;
}
