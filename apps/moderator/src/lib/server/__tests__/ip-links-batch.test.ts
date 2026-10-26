import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UsersService from '$lib/server/users.service';

/**
 * Several addresses checked in one read: one query per source for the whole list, each account once
 * with every address it was seen on, and anything that is not an address named back.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/moderation-memory.service', () => ({
  strikeCountsByUserIds: async () => new Map(),
}));
vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersService>()),
  usersByIds: async (ids: number[]) => new Map(ids.map((id) => [id, { username: `u${id}` }])),
}));

const A = '192.0.2.1';
const B = '198.51.100.7';
const peerQueries: string[] = [];
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      if (sql.includes('groupUniqArray(50)(cluster)')) {
        peerQueries.push(sql);
        return [
          { uid: '7', clusters: [A, B], last: '2026-10-20 00:00:00', total: '2' },
          { uid: '8', clusters: [B], last: '2026-10-19 00:00:00', total: '2' },
        ];
      }
      if (sql.includes('uniqExact(uid)'))
        return [
          { cluster: A, accounts: '1' },
          { cluster: B, accounts: '2' },
        ];
      return [];
    },
  }),
}));

const { getAccountsOnAddresses } = await import('../ip-links.service');

beforeEach(() => {
  peerQueries.length = 0;
});

describe('getAccountsOnAddresses', () => {
  it('reads the whole list in one query per source, not one per address', async () => {
    await getAccountsOnAddresses([A, B]);
    expect(peerQueries).toHaveLength(2);
    for (const q of peerQueries) {
      expect(q).toContain(A);
      expect(q).toContain(B);
    }
  });

  it('lists an account seen on several of the addresses once, with each of them', async () => {
    const { linked } = await getAccountsOnAddresses([A, B]);
    expect(linked!.accounts.map((a) => a.userId)).toEqual([7, 8]);
    expect(linked!.accounts[0].login).toEqual([A, B]);
  });

  it('keeps the count of accounts per address', async () => {
    const { linked } = await getAccountsOnAddresses([A, B]);
    expect(linked!.addresses.filter((a) => a.source === 'login')).toEqual([
      { cluster: A, source: 'login', accounts: 1 },
      { cluster: B, source: 'login', accounts: 2 },
    ]);
  });

  it('names what is not an address, and reads nothing when none is', async () => {
    expect((await getAccountsOnAddresses([A, 'not-an-ip'])).invalid).toEqual(['not-an-ip']);
    peerQueries.length = 0;
    expect(await getAccountsOnAddresses(['nope', 'also-not'])).toEqual({
      linked: null,
      invalid: ['nope', 'also-not'],
    });
    expect(peerQueries).toHaveLength(0);
  });
});
