import { TicketStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { cb, parseCallback } from '../../src/security/callback-data';

describe('parseCallback', () => {
  it('разбирает все генерируемые payload (round-trip)', () => {
    expect(parseCallback(cb.menu)).toEqual({ type: 'menu' });
    expect(parseCallback(cb.userBranch(3))).toEqual({ type: 'user_branch', branchId: 3 });
    expect(parseCallback(cb.userList('closed', 2))).toEqual({ type: 'user_list', kind: 'closed', page: 2 });
    expect(parseCallback(cb.ticketPhotos(15))).toEqual({ type: 'ticket_photos', number: 15 });
    expect(parseCallback(cb.ticket(15))).toEqual({ type: 'ticket_open', number: 15 });
    expect(parseCallback(cb.adminQueue('mine', 1))).toEqual({ type: 'admin_queue', kind: 'mine', page: 1 });
    expect(parseCallback(cb.adminAccept(9))).toEqual({ type: 'admin_accept', number: 9 });
    expect(parseCallback(cb.adminStatusSet(9, TicketStatus.RESOLVED))).toEqual({ type: 'admin_status_set', number: 9, status: TicketStatus.RESOLVED });
    expect(parseCallback(cb.adminCommentStart(9, 'user'))).toEqual({ type: 'admin_comment_start', number: 9, kind: 'user' });
    expect(parseCallback(cb.adminTransferTo(9, 4))).toEqual({ type: 'admin_transfer_to', number: 9, adminId: 4 });
    expect(parseCallback(cb.superDisable(2))).toEqual({ type: 'super_disable', adminId: 2 });
  });

  it('отвергает мусор, лишние сегменты, отрицательные и нечисловые значения', () => {
    for (const bad of [undefined, '', 'x', 'a:acc', 'a:acc:-1', 'a:acc:abc', 'a:acc:1:2', 'a:st:1:zz', 'a:q:evil:0', 'u:br:1.5', 't:99999999999', 'm:1', 'x'.repeat(100)]) {
      expect(parseCallback(bad)).toBeNull();
    }
  });
});

describe('parseCallback: статистика и архив', () => {
  it('round-trip', () => {
    expect(parseCallback(cb.adminStatsMenu)).toEqual({ type: 'admin_stats_menu' });
    expect(parseCallback(cb.adminStats('staff', 3))).toEqual({ type: 'admin_stats', view: 'staff', idx: 3 });
    expect(parseCallback(cb.adminArchive('m', 2, 3, true))).toEqual({ type: 'admin_archive', period: 'm', branchId: 2, page: 3, useQuery: true });
    expect(parseCallback(cb.adminArchiveBranches('w', false))).toEqual({ type: 'admin_archive_branches', period: 'w', useQuery: false });
    expect(parseCallback(cb.adminArchiveSearch('a', 4))).toEqual({ type: 'admin_archive_search', period: 'a', branchId: 4 });
  });
  it('отвергает подделки', () => {
    for (const bad of ['a:s:x:1', 'a:s:o:4', 'a:s:o:0', 'a:s:o:1:1', 'a:ar:z:0:0:0', 'a:ar:a:-1:0:0', 'a:ar:a:0:0:2', 'a:ar:a:0:0', 'a:arb:a:2', 'a:ars:q:0']) {
      expect(parseCallback(bad)).toBeNull();
    }
  });
});
