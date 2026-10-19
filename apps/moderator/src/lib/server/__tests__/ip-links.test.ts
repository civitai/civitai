import { describe, expect, it, vi } from 'vitest';

/**
 * The linked-accounts reader: grouping a suspect set through the addresses its members share, hiding
 * the addresses from a viewer who may not read them, and reading only the account's OWN login rows.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/moderation-memory.service', () => ({
  strikeCountsByUserIds: async () => new Map(),
}));
// Every query is recorded; each read answers as if the account had one address another account shares.
const queries: string[] = [];
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('groupUniqArray(userId)') || sql.includes('groupUniqArray(targetUserId)'))
        return [{ cluster: '192.0.2.1', members: ['5', '6'] }];
      if (sql.includes('GROUP BY ip ORDER BY last'))
        return [{ ip: '192.0.2.1', last: '2026-10-18 00:00:00' }];
      return [];
    },
  }),
}));

const { connect, getAccountsOnAddress, getLinkedAccounts, getSetLinks, maskLinkedAddresses } =
  await import('../ip-links.service');
const { OWN_ACTIVITY_ONLY } = await import('../clickhouse-filters');

describe('login addresses', () => {
  it('read only rows the account made itself, never a moderator action logged against it', async () => {
    queries.length = 0;
    await getLinkedAccounts(5);
    await getSetLinks([5, 6]);
    await getAccountsOnAddress('192.0.2.1');
    const loginReads = queries.filter((q) => q.includes('userActivities'));
    expect(loginReads.length).toBeGreaterThanOrEqual(6);
    for (const q of loginReads) expect(q).toContain(OWN_ACTIVITY_ONLY);
  });
});

describe('connect', () => {
  it('groups accounts joined through any chain of shared addresses', () => {
    const groups = connect(
      [1, 2, 3, 4, 5],
      [
        { members: [1, 2], source: 'reaction' },
        { members: [2, 3], source: 'reaction' },
        { members: [4, 99], source: 'login' },
      ]
    );
    expect(groups).toEqual([
      { members: [1, 2, 3], viaLoginToo: false },
      { members: [4], viaLoginToo: false },
      { members: [5], viaLoginToo: false },
    ]);
  });

  it('says when a group is also joined by a login address', () => {
    const [group] = connect(
      [1, 2],
      [
        { members: [1, 2], source: 'reaction' },
        { members: [1, 2], source: 'login' },
      ]
    );
    expect(group).toEqual({ members: [1, 2], viaLoginToo: true });
  });
});

describe('maskLinkedAddresses', () => {
  it('labels each address consistently and leaves none of them in the output', () => {
    const masked = maskLinkedAddresses({
      days: 180,
      totals: { login: 2, reaction: 1 },
      matched: 2,
      truncated: false,
      addresses: [
        { cluster: '1.2.3.4', source: 'login', accounts: 2 },
        { cluster: '2001:db8::/64', source: 'reaction', accounts: 3 },
      ],
      accounts: [
        {
          userId: 7,
          username: 'a',
          status: 'active',
          muted: false,
          strikes: 0,
          login: ['1.2.3.4'],
          reaction: ['2001:db8::/64'],
          narrowest: 2,
          last: '',
        },
        {
          userId: 8,
          username: 'b',
          status: 'banned',
          muted: false,
          strikes: 1,
          login: ['1.2.3.4'],
          reaction: [],
          narrowest: 2,
          last: '',
        },
      ],
    });
    expect(JSON.stringify(masked)).not.toMatch(/1\.2\.3\.4|2001:db8/);
    expect(masked.accounts.map((a) => a.login)).toEqual([['address 1'], ['address 1']]);
    expect(masked.accounts[0].reaction).toEqual(['address 2']);
  });
});
