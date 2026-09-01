import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Three properties here fail silently — the page renders a full, plausible table in every case.
 *
 * `concentration` is the page's whole product: without it the ranking is raw count, which on the
 * account this was built against put the confirmed sock sixth among thirteen indistinguishable rows.
 *
 * The IPv6 `/64` grouping has to happen inside the query. Grouped afterwards, `HAVING uniq(...) > 1`
 * runs per exact address, and the rotation case it exists to catch — two accounts on one prefix, never
 * on the same suffix — is exactly what it drops.
 *
 * `totalAccounts: null` is not `0`. Zero sorts to the top as the strongest possible signal; the panel
 * orders narrowest-first, so an address with no login history behind it would lead the list.
 */

const chQueries = vi.hoisted(() => [] as string[]);
const chRows = vi.hoisted(() => [] as unknown[][]);

vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: (sql: string) => {
      chQueries.push(sql);
      return Promise.resolve(chRows.shift() ?? []);
    },
  }),
}));

const pgQueries = vi.hoisted(() => [] as string[]);

// Real Kysely on a driver that never connects, so `hydrate` resolves and the Postgres halves are
// asserted on the SQL they actually emit. Built inside the factory: `vi.hoisted` runs before imports.
vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(pgQueries);
  return { dbRead: db, dbWrite: db };
});

vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users.service')>()),
  usersByIds: (ids: number[]) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [id, { username: `u${id}`, bannedAt: null, muted: false, deletedAt: null }])
      )
    ),
}));

vi.mock('$lib/server/moderation-memory.service', () => ({
  strikeCountsByUserIds: () => Promise.resolve(new Map()),
}));

const { getInflationActors, getSharedIps } = await import('../reactor-lookup.service');

beforeEach(() => {
  chQueries.length = 0;
  chRows.length = 0;
  pgQueries.length = 0;
});

const runReactors = (days: number, minCount = 5) =>
  getInflationActors(2832460, { category: 'reactions', days, minCount });

describe('getReactors', () => {
  it('counts reactions GIVEN, never reactions withdrawn', async () => {
    await runReactors(3);

    expect(chQueries[0]).toContain("'Image_Delete'");
    expect(chQueries[0]).toMatch(/type NOT IN \(/);
    // The revert: an `IN` here counts withdrawals as engagement, and one account that reacted then
    // unreacted renders as two events.
    expect(chQueries[0]).not.toMatch(/type IN \(/);
  });

  it('ranks by concentration, and caps AFTER scoring', async () => {
    await runReactors(3);

    const q = chQueries[0];
    expect(q).toContain('ORDER BY count / total DESC');
    // 🔴 The revert that costs the page its purpose. Ranking by raw count and cutting at the limit
    // drops a 100%-on-one-creator account with 31 reactions — rank 151 by count on the measured
    // case — while keeping thirteen ordinary accounts with 380-410 each.
    expect(q).not.toMatch(/ORDER BY count DESC\s*\n?\s*LIMIT/);
  });

  it('computes the denominator over ALL owners, in the same pass', async () => {
    await runReactors(3);

    const q = chQueries[0];
    expect(q).toContain('countIf(ownerId = 2832460) AS count');
    expect(q).toContain('count() AS total');
    expect(q).toContain('uniq(ownerId) AS owners');
    // Filtering the pass to the target makes `total` equal `count`, every row 100%, and the ranking
    // it feeds meaningless.
    expect(q).not.toMatch(/WHERE[^]*ownerId = 2832460/);
  });

  it('applies the volume floor', async () => {
    await runReactors(3, 5);

    // Without it, concentration ordering puts accounts that reacted ONCE — trivially "100%" — at the
    // head of the list; 15 of the 20 such rows on the measured account were single reactions.
    expect(chQueries[0]).toContain('HAVING count >= 5');
  });

  it('bounds the pass by the window', async () => {
    await runReactors(30);

    // `time` is the table's leading sort key across 844M rows; an unbounded pass scans all of it.
    expect(chQueries[0]).toContain('time >= now() - INTERVAL 30 DAY');
  });

  it('reports the population over the floor, not the page size', async () => {
    chRows.push([
      { userId: '1', count: '9', entities: '9', total: '9', owners: '1', matched: '1340' },
    ]);
    const report = await getInflationActors(2832460, {
      category: 'reactions',
      days: 3,
      minCount: 5,
    });

    // `.length` here would render the cap as the answer — "100 reactors" on a creator with 1,340.
    expect(report?.total).toBe(1340);
  });
});

describe('getSharedIps', () => {
  const twoAccounts = [1, 2];
  const TARGET = 2832460;

  it('groups and filters by the /64 cluster inside the query', async () => {
    chRows.push([], []);
    await getSharedIps(twoAccounts, { targetId: TARGET });

    const q = chQueries[0];
    expect(q).toContain('IPv6CIDRToRange(toIPv6OrDefault(ip), 64)');
    expect(q).toContain('GROUP BY cluster');
    // The revert. Grouping by the raw address puts the rotation case — the reason the clustering
    // exists — on the wrong side of the HAVING, and it is dropped before anything can regroup it.
    expect(q).not.toMatch(/GROUP BY ip\b/);
    expect(q).toContain('HAVING uniq(targetUserId) > 1');
  });

  it('keeps IPv4 out of the /64 branch', async () => {
    chRows.push([], []);
    await getSharedIps(twoAccounts, { targetId: TARGET });

    // `toIPv6` maps IPv4 into `::ffff:0:0/96`, so an unbranched /64 collapses every IPv4 address in
    // the table into one bucket carrying every account on the site.
    expect(chQueries[0]).toContain("position(ip, ':') > 0");
  });

  it('ranks clusters holding the creator above the LIMIT, then narrowest', async () => {
    chRows.push([], []);
    await getSharedIps(twoAccounts, { targetId: TARGET });

    // Ordered in SQL, not after: a cluster holding the creator has to beat the LIMIT, not just the
    // other rows that survived it.
    expect(chQueries[0]).toContain(`ORDER BY max(targetUserId = ${TARGET}) DESC`);
    // Narrowest next. Descending — the instinctive choice — puts VPN exits on top.
    expect(chQueries[0]).toContain('uniq(targetUserId) ASC');
  });

  it('correlates against the creator even when they are not a listed actor', async () => {
    chRows.push([], []);
    await getSharedIps([111, 222], { targetId: TARGET });

    // 🔴 A creator appears among their own reactors only via self-reactions, and plenty have none.
    // Left out, the panel cannot test the one thing it is best at — "this reactor and the account
    // they are boosting are the same person" — and simply shows fewer rows.
    expect(chQueries[0]).toContain(`IN (111,222,${TARGET})`);
  });

  it('reports unmeasured breadth as null, not zero', async () => {
    chRows.push(
      [{ cluster: '203.0.113.7', userIds: ['1', '2'], ips: ['203.0.113.7'] }],
      // `userActivities` holds no row for that address — nothing to measure breadth against.
      []
    );
    const [account] = await getSharedIps(twoAccounts, { targetId: TARGET });

    expect(account.addresses[0].totalAccounts).toBeNull();
  });

  it('carries breadth through from the activity log', async () => {
    chRows.push(
      [{ cluster: '203.0.113.7', userIds: ['1', '2'], ips: ['203.0.113.7'] }],
      [{ cluster: '203.0.113.7', total: '358' }]
    );
    const [account] = await getSharedIps(twoAccounts, { targetId: TARGET });

    expect(account.addresses[0].totalAccounts).toBe(358);
  });

  it('keys by account, folding one account’s many addresses into one entry', async () => {
    chRows.push(
      // The rotation case: one pair, six addresses. Address-keyed, this is six near-identical rows.
      [
        { cluster: '88.7.201.83', userIds: ['7717426', String(TARGET)], ips: ['88.7.201.83'] },
        { cluster: '88.7.202.107', userIds: ['7717426', String(TARGET)], ips: ['88.7.202.107'] },
        { cluster: '88.4.144.13', userIds: ['7717426', String(TARGET)], ips: ['88.4.144.13'] },
      ],
      [{ cluster: '88.7.201.83', total: '2' }]
    );
    const accounts = await getSharedIps([7717426], { targetId: TARGET });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].userId).toBe(7717426);
    expect(accounts[0].addresses).toHaveLength(3);
    // The creator gets no entry of its own — it is a member of every finding, so its entry would be
    // a copy of the whole panel.
    expect(accounts.some((a) => a.userId === TARGET)).toBe(false);
    expect(accounts[0].withTarget).toBe(true);
    expect(accounts[0].peers.map((p) => p.isTarget)).toEqual([true]);
  });

  it('sorts a measured address above an unmeasured one', async () => {
    chRows.push(
      [
        { cluster: '198.51.100.9', userIds: ['1', '2'], ips: ['198.51.100.9'] },
        { cluster: '203.0.113.7', userIds: ['1', '2'], ips: ['203.0.113.7'] },
      ],
      [{ cluster: '203.0.113.7', total: '2' }]
    );
    const [account] = await getSharedIps(twoAccounts, { targetId: TARGET });

    // `null` breadth means "no history to measure", which is WEAKER than a measured 2. Sorting it as
    // `?? 0` would rank the one thing nothing is known about as the strongest evidence on the page.
    expect(account.addresses[0].cluster).toBe('203.0.113.7');
  });

  it('is NOT bounded by the page lookback', async () => {
    chRows.push([], []);
    await getSharedIps(twoAccounts, { targetId: TARGET });

    // 🔴 The revert that quietly costs the panel its best evidence. On the case this was built from,
    // the sock and the target share two addresses last used FIVE MONTHS ago — outside every lookback
    // the page offers. A window here is invisible: the panel still renders, just emptier.
    expect(chQueries[0]).not.toContain('INTERVAL');
    expect(chQueries[0]).not.toContain('time >=');
  });

  it('excludes private space, which correlates everyone', async () => {
    chRows.push([], []);
    await getSharedIps(twoAccounts, { targetId: TARGET });

    for (const range of ['10.0.0.0/8', '192.168.0.0/16', 'fc00::/7']) {
      expect(chQueries[0]).toContain(`NOT isIPAddressInRange(ip, '${range}')`);
    }
  });

  it('does not query at all for a single account', async () => {
    // One account shares an address with nobody by definition, and the id list is interpolated
    // unescaped — an unguarded call is a scan with a one-element IN.
    expect(await getSharedIps([1], { targetId: 1 })).toEqual([]);
    expect(chQueries).toHaveLength(0);
  });
});

describe('PUBLIC_IP_ONLY', () => {
  it('guards the empty string before any range check', async () => {
    chRows.push([], []);
    await getSharedIps([1, 2], { targetId: 3 });

    // 🔴 `isIPAddressInRange` RAISES on '', and `userActivities` holds a few. Without this the
    // stickers and collections panels fail only when a blank row lands in the scanned range — so it
    // passes in testing and breaks later, for one moderator, once.
    const q = chQueries[0];
    expect(q).toContain("ip != ''");
    expect(q.indexOf("ip != ''")).toBeLessThan(q.indexOf('isIPAddressInRange'));
  });
});

describe('getCollectionAdders', () => {
  it('passes the image set as a subquery, never as a materialised id list', async () => {
    await getInflationActors(2832460, { category: 'collections', days: 3, minCount: 5 });

    const grouped = pgQueries.find((q) => q.includes('"CollectionItem"'));
    // The cap is 20k images. Fetched into JS and pasted back, that is 20k bind parameters and an
    // extra round trip, for a plan Postgres drives as the same nested loop of index probes either way.
    expect(grouped).toContain('select "id" from "Image"');
    expect(grouped).not.toMatch(/\$\d{4,}/);
  });

  it('excludes the creator collecting their own work', async () => {
    await getInflationActors(2832460, { category: 'collections', days: 3, minCount: 5 });

    // Left in, it takes the top row and pushes the rows worth reading off the end of the limit.
    expect(pgQueries.find((q) => q.includes('"CollectionItem"'))).toContain('"addedById" !=');
  });
});
