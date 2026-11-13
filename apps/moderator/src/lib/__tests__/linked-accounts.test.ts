import { describe, expect, it } from 'vitest';
import { rankAccountLinks, type AccountLinkRow } from '$lib/linked-accounts';

const row = (userId: number, extra: Partial<AccountLinkRow> = {}): AccountLinkRow => ({
  userId,
  username: `u${userId}`,
  status: 'active',
  muted: false,
  strikes: 0,
  ...extra,
});

const nearOnly = { nearLogin: { ips: ['1.1.1.1'], addresses: 1, closestSeconds: 5, logins: 1 } };
const buzz = { buzz: { rank: 1, inCount: 3, outCount: 2, inAmount: 300, outAmount: 200 } };

describe('rankAccountLinks', () => {
  it('puts two kinds of evidence above one, even when the single-signal account is banned', () => {
    const ranked = rankAccountLinks([
      row(1, { ...nearOnly, status: 'banned' }),
      row(2, { ...nearOnly, ...buzz }),
    ]);
    expect(ranked.map((r) => r.userId)).toEqual([2, 1]);
  });

  it('breaks a tie on evidence count by banned first, then by Buzz counterparty rank', () => {
    const ranked = rankAccountLinks([
      row(1, { buzz: { ...buzz.buzz, rank: 1 } }),
      row(2, { buzz: { ...buzz.buzz, rank: 4 }, status: 'banned' }),
      row(3, { buzz: { ...buzz.buzz, rank: 2 } }),
    ]);
    expect(ranked.map((r) => r.userId)).toEqual([2, 1, 3]);
  });
});
