import { describe, expect, it } from 'vitest';
import {
  bulkBanHref,
  initialBanSelection,
  rankLinkedAccounts,
  toggleId,
  type LinkedAccountRow,
} from '$lib/linked-accounts';

const row = (userId: number, extra: Partial<LinkedAccountRow> = {}): LinkedAccountRow => ({
  userId,
  username: `u${userId}`,
  bannedAt: null,
  muted: false,
  strikes: 0,
  ...extra,
});

const nearOnly = { nearLogin: { ips: ['1.1.1.1'], closestSeconds: 5, logins: 1 } };
const buzz = { buzz: { rank: 1, inCount: 3, outCount: 2, inAmount: 300, outAmount: 200 } };

describe('rankLinkedAccounts', () => {
  it('puts two kinds of evidence above one, even when the single-signal account is banned', () => {
    const ranked = rankLinkedAccounts([
      row(1, { ...nearOnly, bannedAt: '2026-10-01T00:00:00Z' }),
      row(2, { ...nearOnly, ...buzz }),
    ]);
    expect(ranked.map((r) => r.userId)).toEqual([2, 1]);
  });

  it('breaks a tie on evidence count by banned first, then by Buzz counterparty rank', () => {
    const ranked = rankLinkedAccounts([
      row(1, { buzz: { ...buzz.buzz, rank: 1 } }),
      row(2, { buzz: { ...buzz.buzz, rank: 4 }, bannedAt: '2026-10-01T00:00:00Z' }),
      row(3, { buzz: { ...buzz.buzz, rank: 2 } }),
    ]);
    expect(ranked.map((r) => r.userId)).toEqual([2, 1, 3]);
  });
});

describe('Bulk Ban hand-off', () => {
  it('starts with nothing selected, corroborated and banned accounts included', () => {
    const rows = [
      row(1, { ...nearOnly, ...buzz, bannedAt: '2026-10-01T00:00:00Z' }),
      row(2, { ...nearOnly, ...buzz, regIp: { ips: ['2.2.2.2'] } }),
      row(3, nearOnly),
    ];
    const selected = initialBanSelection(rows);
    expect(selected).toEqual([]);
    expect(bulkBanHref(selected)).toBeNull();
  });

  it('hands over exactly the accounts ticked', () => {
    const selected = toggleId(toggleId(toggleId([], 7), 9), 7);
    expect(bulkBanHref(selected)).toBe(`/retool/bulk-ban?ids=${encodeURIComponent('9')}`);
  });
});
