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
// Logins and reactions answer differently, so an answer read under the wrong source shows.
const answers = {
  login: {
    peers: [
      { uid: '7', clusters: [A, B], last: '2026-10-20 00:00:00', total: '2' },
      { uid: '8', clusters: [B], last: '2026-10-19 00:00:00', total: '2' },
    ],
    breadth: [
      { cluster: A, accounts: '1' },
      { cluster: B, accounts: '2' },
    ],
  },
  reaction: {
    peers: [{ uid: '9', clusters: [A], last: '2026-10-18 00:00:00', total: '1' }],
    breadth: [
      { cluster: A, accounts: '4' },
      { cluster: B, accounts: '0' },
    ],
  },
};
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      const source = sql.includes('default.userActivities') ? answers.login : answers.reaction;
      if (sql.includes('groupUniqArray(50)(cluster)')) {
        peerQueries.push(sql);
        return source.peers;
      }
      if (sql.includes('uniqExact(uid)')) return source.breadth;
      return [];
    },
  }),
}));

const { getAccountsOnAddresses } = await import('../ip-links.service');
const { ipCluster } = await import('../ip-clusters');

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

  // The outer query groups by account alone: grouped by account and address, an account on two of
  // the addresses would come back as two rows, each with one address.
  it('lists an account seen on several of the addresses once, with each of them', async () => {
    const { linked } = await getAccountsOnAddresses([A, B]);
    for (const q of peerQueries)
      expect(q).toMatch(/groupUniqArray\(50\)\(cluster\)[\s\S]*GROUP BY uid\s*\)/);
    const seven = linked!.accounts.find((a) => a.userId === 7)!;
    expect(seven.login).toEqual([A, B]);
    expect(linked!.accounts.filter((a) => a.userId === 7)).toHaveLength(1);
  });

  it('keeps each source to its own accounts and addresses', async () => {
    const { linked } = await getAccountsOnAddresses([A, B]);
    const byId = new Map(linked!.accounts.map((a) => [a.userId, a]));
    expect(byId.get(7)).toMatchObject({ login: [A, B], reaction: [] });
    expect(byId.get(9)).toMatchObject({ login: [], reaction: [A] });
  });

  it('keeps the count of accounts per address, per source', async () => {
    const { linked } = await getAccountsOnAddresses([A, B]);
    expect(linked!.addresses).toEqual([
      { cluster: A, source: 'login', accounts: 1 },
      { cluster: A, source: 'reaction', accounts: 4 },
      { cluster: B, source: 'login', accounts: 2 },
      { cluster: B, source: 'reaction', accounts: 0 },
    ]);
  });

  it('takes an IPv6 /64 key as given, and reads two addresses in one /64 as that one prefix', async () => {
    const prefix = ipCluster('2001:db8:abc::1')!;
    const { linked, invalid } = await getAccountsOnAddresses([
      '2001:db8:abc::1',
      '2001:db8:abc::2',
      prefix,
    ]);
    expect(invalid).toEqual([]);
    expect(linked!.addresses.filter((a) => a.source === 'login').map((a) => a.cluster)).toEqual([
      prefix,
    ]);
  });

  // No stored address has a zero-padded octet, so one would read as an address with no accounts.
  it('names a zero-padded IPv4 address back instead of reading it', async () => {
    const { invalid } = await getAccountsOnAddresses([A, '01.2.3.4', '192.0.2.010', '10.0.0.1']);
    expect(invalid).toEqual(['01.2.3.4', '192.0.2.010']);
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
