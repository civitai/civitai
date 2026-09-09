import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Both account searches cap at 500, and until 2026-08-28 both spent that cap on the OLDEST accounts —
 * `ORDER BY targetUserId` / `orderBy('id')`, and ids ascend with age. On the IP a moderator reported,
 * that showed 500 of 908 registrations and stopped sixteen months before the newest one, on a list
 * whose whole purpose is a ring still registering accounts today.
 *
 * The order is the only thing standing between the cap and a useless list, and it is invisible in the
 * rendered page — every row looks right, there are just the wrong 500 of them. So the assertions read
 * the SQL that was actually emitted: real Kysely on a driver that never connects for the Postgres half,
 * and a captured query string for the ClickHouse half.
 */

const captured = vi.hoisted(() => [] as string[]);
const chQueries = vi.hoisted(() => [] as string[]);
const chRows = vi.hoisted(() => [] as unknown[][]);
const userRows = vi.hoisted(
  () =>
    new Map<number, { username: string | null; bannedAt: Date | null; deletedAt: Date | null }>()
);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports, so
// constructing the client there reads it before initialisation.
vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured);
  return { dbRead: db, dbWrite: db };
});

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: (sql: string) => {
      chQueries.push(sql);
      return Promise.resolve(chRows.shift() ?? []);
    },
  }),
}));

vi.mock('$lib/server/users.service', () => ({
  usersByIds: (ids: number[]) =>
    Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const row = userRows.get(id);
          return row ? [[id, { ...row, muted: false }] as const] : [];
        })
      )
    ),
}));

const { getAccountsOnIps, getAccountsOnDomains } = await import('../bulk-ban.service');

describe('getAccountsOnIps', () => {
  // `chRows` is a QUEUE. Left unreset it balances only while every test pushes exactly two entries and
  // both queries always fire — one early-return case and the next test silently reads the previous
  // test's rows, with every SQL-shape assertion still passing.
  beforeEach(() => {
    chQueries.length = 0;
    chRows.length = 0;
    userRows.clear();
  });

  const run = (opts?: { offset?: number }) => getAccountsOnIps(['203.0.113.7'], opts);

  it('spends the cap on the NEWEST registrations', async () => {
    chRows.push([], [{ total: '0' }]);
    await run();

    const page = chQueries[0];
    expect(page).toContain('ORDER BY time DESC, targetUserId DESC');
    // The revert. `targetUserId` ascends with age, so ordering by it alone kept the oldest 500.
    expect(page).not.toContain('ORDER BY targetUserId');
    expect(page).toMatch(/LIMIT 500/);
  });

  it('counts what the IPs carry, not what the page returned', async () => {
    // The bug this replaces was a header reading "(500)" off `.length` — the cap stated as the answer.
    chRows.push([{ targetUserId: '1', time: '2026-08-28 12:11:05' }], [{ total: '908' }]);
    const result = await run();

    expect(result.accounts).toHaveLength(1);
    expect(result.total).toBe(908);
    expect(chQueries[1]).toMatch(/uniqExact\(targetUserId\)/);
  });

  it('scopes the count to the same IPs and event type as the page', async () => {
    // Two queries, one predicate. A count over a wider set would overstate the ring every time.
    chRows.push([], [{ total: '0' }]);
    await run();

    for (const q of chQueries) {
      expect(q).toContain("ip IN ('203.0.113.7')");
      expect(q).toContain("type = 'Registration'");
    }
  });

  // Marking already-banned accounts instead of hiding them is what removes the drain: ban the visible
  // 500, re-run, and the identical 500 come back badged. Without an offset the other 408 on a reported
  // IP are unreachable by any sequence of actions, which is the original bug relocated rather than fixed.
  it('walks past the cap on request', async () => {
    chRows.push([], [{ total: '908' }]);
    await run({ offset: 500 });

    expect(chQueries[0]).toMatch(/LIMIT 500 OFFSET 500/);
  });

  it('reports the window it returned, so the panel can offer the next one', async () => {
    chRows.push([{ targetUserId: '1', time: '2026-08-28 12:11:05' }], [{ total: '908' }]);
    const result = await run({ offset: 500 });

    expect(result).toMatchObject({ offset: 500, limit: 500, total: 908 });
  });

  it('breaks ties on the id, so a page boundary cannot repeat or skip a row', async () => {
    // Bot registrations share a timestamp to the second. `ORDER BY time DESC` alone is not a total
    // order, so rows either side of an offset are free to swap between the two requests.
    chRows.push([], [{ total: '0' }]);
    await run();

    expect(chQueries[0]).toContain('ORDER BY time DESC, targetUserId DESC');
  });

  it('marks an account it cannot ban instead of dropping it', async () => {
    // Filtering these out would make the list drain as it is worked, and hide that the ring has been
    // actioned before — which is what the panel is read for.

    userRows.set(1, { username: 'live', bannedAt: null, deletedAt: null });
    userRows.set(2, { username: 'gone-already', bannedAt: new Date(), deletedAt: null });
    userRows.set(3, { username: 'removed', bannedAt: null, deletedAt: new Date() });
    chRows.push(
      [1, 2, 3, 4].map((id) => ({ targetUserId: String(id), time: '2026-08-28 12:11:05' })),
      [{ total: '4' }]
    );

    const { accounts } = await run();

    expect(accounts.map((a) => a.status)).toEqual(['active', 'banned', 'deleted', 'gone']);
    // 4 has no Postgres row at all: reporting it as bannable sends a moderator to a dead link.
    expect(accounts[3]).toMatchObject({ userId: 4, username: null });
  });
});

describe('getAccountsOnDomains', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  const run = () => getAccountsOnDomains(['@example.invalid']);

  it('spends the cap on the newest accounts', async () => {
    await run();

    const page = captured.find((q) => q.includes('limit'));
    expect(page).toMatch(/order by "id" desc/i);
  });

  it('counts with the same three predicates the page filters on', async () => {
    // A count over a different set describes a different search — and the domain expression and both
    // null checks are what `User_email_domain_idx` matches character-for-character.
    await run();

    expect(captured).toHaveLength(2);
    for (const q of captured) {
      expect(q).toContain(`lower(substring(email from '@(.+)$'))`);
      expect(q).toContain('"bannedAt" is null');
      expect(q).toContain('"deletedAt" is null');
    }
  });
});
