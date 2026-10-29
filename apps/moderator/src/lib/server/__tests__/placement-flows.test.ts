import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real Kysely on a driver that never connects: which placements are in scope, and which legs count as
// moved, live only in the emitted SQL.
const captured = vi.hoisted(() => [] as string[]);
const params = vi.hoisted(() => [] as unknown[][]);
const answers = vi.hoisted(() => ({ current: (_sql: string): unknown[] => [] }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, (sql) => answers.current(sql), params);
  return { dbRead: db, dbWrite: db };
});
vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users.service')>()),
  usersByIds: async (ids: number[]) => new Map(ids.map((id) => [id, { username: `u${id}` }])),
}));

const { getPlacementFlows, PAIR_LIMIT, placementIdOf } = await import('../placement-flows.service');

const pair = (o: Record<string, unknown> = {}) => ({
  placerId: 1,
  ownerId: 2,
  sellerId: null,
  surface: 'sticker',
  currency: 'green',
  placements: '3',
  free: '1',
  pending: '0',
  approved: '2',
  declined: '1',
  expired: '0',
  removed: '0',
  held: '30',
  refunded: '5',
  toOwner: '20',
  toSeller: '0',
  toPlatform: '5',
  forfeited: '0',
  ...o,
});

/** Canned rows per query, told apart by what each one selects. */
const respond = (r: {
  pairs?: unknown[];
  placed?: unknown[];
  received?: unknown[];
  stickers?: unknown[];
  cosmetics?: unknown[];
}) =>
  (answers.current = (sql) =>
    sql.includes('from "Cosmetic"')
      ? r.cosmetics ?? []
      : sql.includes('"cosmeticId"')
      ? r.stickers ?? []
      : sql.includes('"p"."placerId" as "userId"')
      ? r.placed ?? []
      : sql.includes('"p"."ownerId" as "userId"')
      ? r.received ?? []
      : r.pairs ?? []);

beforeEach(() => {
  captured.length = 0;
  params.length = 0;
  respond({});
});

describe('getPlacementFlows', () => {
  it('matches the set as placer or owner inside the window, and never by seller', async () => {
    respond({ pairs: [pair()] });
    await getPlacementFlows([1, 2], 30);
    // Pairs, placed, received, then the shown pair's stickers; the cosmetic names read nothing here.
    expect(captured).toHaveLength(4);
    for (const [i, sql] of captured.entries()) {
      expect(sql).toMatch(/\("p"\."placerId" in \(\$\d+, \$\d+\) or "p"\."ownerId" in/);
      expect(sql).toMatch(/"p"\."createdAt" >= \$\d+/);
      expect(sql).not.toMatch(/"sellerId" in/);
      expect(params[i]).toEqual(expect.arrayContaining([1, 2]));
    }
    const since = params[0].find((p) => p instanceof Date) as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThan(29.9 * 86_400_000);
    expect(Date.now() - since.getTime()).toBeLessThan(30.1 * 86_400_000);
  });

  it('caps the window at a year', async () => {
    await getPlacementFlows([1], 10_000);
    const since = params[0].find((p) => p instanceof Date) as Date;
    expect(Date.now() - since.getTime()).toBeLessThan(366 * 86_400_000);
  });

  // A leg with no transactionId is queued, not paid: counting it would report Buzz that never moved.
  it('sums only legs that moved', async () => {
    await getPlacementFlows([1], 30);
    expect(captured[0]).toMatch(/"t"\."transactionId" is not null/);
    // A placement with no spendType predates the column, and its escrow is yellow.
    expect(captured[0]).toContain(`coalesce(p."spendType", 'yellow')`);
    // Scoped to the matched placements, or each call sums every leg in the table.
    expect(captured[0]).toMatch(
      /"t"\."transactionId" is not null and "t"\."placementId" in \(select "p"\."id" from "Placement" as "p" where \("p"\."placerId" in/
    );
  });

  // Each leg kind lands in exactly one column; a kind left out reads as Buzz still in escrow.
  it('sums each leg kind into its own column', async () => {
    await getPlacementFlows([1], 30);
    const legs: Record<string, unknown[]> = {};
    for (const m of captured[0].matchAll(/t\.kind in \(([^)]*)\)\), 0\) as "(\w+)"/g))
      legs[m[2]] = [...m[1].matchAll(/\$(\d+)/g)].map((n) => params[0][Number(n[1]) - 1]);
    expect(legs).toEqual({
      held: ['holdFee', 'holdPrincipal'],
      refunded: ['principalToPlacer', 'feeToPlacer'],
      toOwner: ['toOwner', 'feeToOwner'],
      toSeller: ['toSeller'],
      toPlatform: ['toPlatform'],
      forfeited: ['forfeit'],
    });
  });

  it('reads nothing for an empty or out-of-range set', async () => {
    expect(await getPlacementFlows([0, -3, 2 ** 31], 30)).toEqual({
      days: 30,
      accounts: [],
      pairs: [],
      truncated: false,
    });
    expect(captured).toHaveLength(0);
  });

  it('lists pairs inside the set first and says when the cap cut the list', async () => {
    respond({
      pairs: Array.from({ length: PAIR_LIMIT + 1 }, (_, i) => pair({ ownerId: 100 + i })),
    });
    const out = await getPlacementFlows([1], 30);
    expect(captured[0]).toMatch(
      /order by \("p"\."placerId" in \(\$\d+\) and "p"\."ownerId" in \(\$\d+\)\) desc, "placements" desc limit \$\d+/
    );
    // One past the cap, so a full page is told apart from a cut one.
    expect(params[0].at(-1)).toBe(PAIR_LIMIT + 1);
    expect(out.pairs).toHaveLength(PAIR_LIMIT);
    expect(out.truncated).toBe(true);

    respond({ pairs: [pair()] });
    expect((await getPlacementFlows([1], 30)).truncated).toBe(false);
  });

  it('names both ends, marks a pair inside the set, and keeps only the statuses that occurred', async () => {
    respond({ pairs: [pair({ toSeller: '3', forfeited: '7' }), pair({ ownerId: 9 })] });
    const [inside, outside] = (await getPlacementFlows([1, 2], 30)).pairs;
    expect(inside).toMatchObject({
      placerName: 'u1',
      ownerName: 'u2',
      withinSet: true,
      placements: 3,
      free: 1,
      held: 30,
      refunded: 5,
      toOwner: 20,
      toSeller: 3,
      toPlatform: 5,
      forfeited: 7,
    });
    expect(inside.statuses).toEqual({ approved: 2, declined: 1 });
    expect(outside.withinSet).toBe(false);
  });

  it('lists the most used stickers on a sticker pair, and none on another surface', async () => {
    const sticker = (o: Record<string, unknown>) => ({
      placerId: 1,
      ownerId: 2,
      sellerId: null,
      currency: 'green',
      ...o,
    });
    respond({
      pairs: [pair(), pair({ surface: 'remixGallery' })],
      stickers: [
        ...[3, 1, 7, 4, 6, 2].map((count, i) =>
          sticker({ cosmeticId: String(10 + i), count: String(count) })
        ),
        sticker({ ownerId: 8, cosmeticId: '99', count: '50' }),
        sticker({ cosmeticId: null, count: '40' }),
      ],
      cosmetics: [{ id: 12, name: 'Star' }],
    });
    const [stickers, remix] = (await getPlacementFlows([1], 30)).pairs;
    expect(stickers.stickers.map((s) => s.count)).toEqual([7, 6, 4, 3, 2]);
    expect(stickers.stickers[0]).toEqual({ cosmeticId: 12, name: 'Star', count: 7 });
    expect(remix.stickers).toEqual([]);
  });

  // A sticker's seller is its creator, so one placer-owner pair splits into a row per creator (and per
  // currency). Each row lists its own stickers, or one creator's are credited to another.
  it("keeps each row's stickers to its own seller and currency", async () => {
    respond({
      pairs: [
        pair({ sellerId: 50 }),
        pair({ sellerId: 60 }),
        pair({ sellerId: 50, currency: 'yellow' }),
      ],
      stickers: [
        { placerId: 1, ownerId: 2, sellerId: 50, currency: 'green', cosmeticId: '10', count: '3' },
        { placerId: 1, ownerId: 2, sellerId: 60, currency: 'green', cosmeticId: '20', count: '1' },
        { placerId: 1, ownerId: 2, sellerId: 50, currency: 'yellow', cosmeticId: '30', count: '2' },
      ],
    });
    const rows = (await getPlacementFlows([1], 30)).pairs;
    expect(rows.map((r) => r.stickers.map((s) => s.cosmeticId))).toEqual([[10], [20], [30]]);
    // The shown pairs exactly, not every shown placer crossed with every shown owner.
    expect(captured.find((q) => q.includes('"cosmeticId"'))).toMatch(
      /\("p"\."placerId", "p"\."ownerId"\) in \(\(\$\d+, \$\d+\)/
    );
    expect(captured.find((q) => q.includes('"cosmeticId"'))).toMatch(
      /group by "p"\."placerId", "p"\."ownerId", "p"\."sellerId", coalesce\(p\."spendType", 'yellow'\), p\.data->>'cosmeticId'/
    );
  });

  it('reads no stickers when no shown pair is a sticker pair', async () => {
    respond({ pairs: [pair({ surface: 'remixGallery' })] });
    await getPlacementFlows([1], 30);
    expect(captured.some((q) => q.includes('"cosmeticId"'))).toBe(false);
  });

  it('totals each account as placer and as owner, by currency', async () => {
    respond({
      placed: [
        {
          userId: 1,
          currency: 'green',
          placements: '4',
          held: '40',
          refunded: '10',
          forfeited: '6',
        },
      ],
      received: [{ userId: 2, currency: 'yellow', placements: '2', earned: '15' }],
    });
    const { accounts } = await getPlacementFlows([1, 2], 30);
    const placedSql = captured.find((q) => q.includes('"p"."placerId" as "userId"'))!;
    const receivedSql = captured.find((q) => q.includes('"p"."ownerId" as "userId"'))!;
    for (const leg of ['held', 'refunded', 'forfeited'])
      expect(placedSql).toContain(`coalesce(sum(t."${leg}"), 0) as "${leg}"`);
    expect(receivedSql).toContain(`coalesce(sum(t."toOwner"), 0) as "earned"`);
    expect(accounts).toEqual([
      {
        userId: 1,
        username: 'u1',
        placed: { green: { placements: 4, held: 40, refunded: 10, forfeited: 6 } },
        received: {},
      },
      {
        userId: 2,
        username: 'u2',
        placed: {},
        received: { yellow: { placements: 2, earned: 15 } },
      },
    ]);
  });
});

describe('placementIdOf', () => {
  it('reads the id from a leg reference and ignores anything else', () => {
    expect(placementIdOf('placement-1204-toOwner')).toBe(1204);
    expect(placementIdOf('placement-1207-holdFee-Green')).toBe(1207);
    for (const ref of [
      null,
      '',
      'placement--toOwner',
      'placement-12',
      'xplacement-1-toOwner',
      'placement-99999999999-toOwner',
    ])
      expect(placementIdOf(ref)).toBeNull();
  });
});
