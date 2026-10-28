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
    await getPlacementFlows([1, 2], 30);
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
    // Scoped to the matched placements, or each call sums every leg in the table.
    expect(captured[0]).toMatch(
      /"t"\."transactionId" is not null and "t"\."placementId" in \(select "p"\."id" from "Placement" as "p" where \("p"\."placerId" in/
    );
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
    respond({ pairs: [pair(), pair({ ownerId: 9 })] });
    const [inside, outside] = (await getPlacementFlows([1, 2], 30)).pairs;
    expect(inside).toMatchObject({
      placerName: 'u1',
      ownerName: 'u2',
      withinSet: true,
      statuses: { approved: 2, declined: 1 },
      held: 30,
      refunded: 5,
      toOwner: 20,
      toPlatform: 5,
    });
    expect(inside.statuses).toEqual({ approved: 2, declined: 1 });
    expect(outside.withinSet).toBe(false);
  });

  it('lists the most used stickers on a sticker pair, and none on another surface', async () => {
    respond({
      pairs: [pair(), pair({ surface: 'remix' })],
      stickers: [
        ...[3, 1, 7, 4, 6, 2].map((count, i) => ({
          placerId: 1,
          ownerId: 2,
          cosmeticId: String(10 + i),
          count: String(count),
        })),
        { placerId: 1, ownerId: 8, cosmeticId: '99', count: '50' },
        { placerId: 1, ownerId: 2, cosmeticId: null, count: '40' },
      ],
      cosmetics: [{ id: 12, name: 'Star' }],
    });
    const [sticker, remix] = (await getPlacementFlows([1], 30)).pairs;
    expect(sticker.stickers.map((s) => s.count)).toEqual([7, 6, 4, 3, 2]);
    expect(sticker.stickers[0]).toEqual({ cosmeticId: 12, name: 'Star', count: 7 });
    expect(remix.stickers).toEqual([]);
  });

  it('totals each account as placer and as owner, by currency', async () => {
    respond({
      placed: [{ userId: 1, currency: 'green', placements: '4', held: '40', refunded: '10' }],
      received: [{ userId: 2, currency: 'yellow', placements: '2', earned: '15' }],
    });
    const { accounts } = await getPlacementFlows([1, 2], 30);
    expect(accounts).toEqual([
      {
        userId: 1,
        username: 'u1',
        placed: { green: { placements: 4, held: 40, refunded: 10 } },
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
    expect(placementIdOf('placement-31465-toOwner')).toBe(31465);
    expect(placementIdOf('placement-31473-holdFee-Green')).toBe(31473);
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
