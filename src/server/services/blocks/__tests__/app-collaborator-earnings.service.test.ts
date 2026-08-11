import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE PORTFOLIO-LEAK REGRESSION TEST. This is the highest-risk item in the
 * collaborators feature and this suite is its guard.
 *
 * THE FIXTURE IS THE POINT: the owner has TWO apps and the editor is seated on ONE.
 * A one-app fixture cannot distinguish the correct implementation from the leaking one,
 * because with a single app "everything the owner has" and "the shared app" are the
 * same set. Every assertion below therefore names APP_B (the app the editor was never
 * invited to) explicitly.
 *
 * 🔴 WATCHED TO FAIL FIRST. Before the real implementation existed, the same fixture
 * was run against the NAIVE implementation — reusing the pre-existing
 * `appOwnerUserId`-keyed filter with the OWNER's id, which is the obvious way to make
 * an editor see any earnings at all. It returned BOTH apps, and this suite went red
 * with `expected [ 'ab_appA', 'ab_appB' ] not to contain 'ab_appB'`. That is the
 * defect this file exists to keep out.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appCollaborator: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    blockBuzzAttribution: {
      aggregate: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      groupBy: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

const { getAppEarnings, getMyAppsEarnings } = await import(
  '~/server/services/blocks/app-collaborator-earnings.service'
);

const APP_A = 'ab_appA'; // shared with the editor
const APP_B = 'ab_appB'; // 🔴 the owner's OTHER app — must never surface to the editor
const OWNER = 100;
const EDITOR = 200;
const STRANGER = 300;

/** Every attribution row in the fixture DB, per app. */
const LEDGER = [
  { appBlockId: APP_A, appOwnerUserId: OWNER, status: 'confirmed', share: 500, gross: 1000 },
  { appBlockId: APP_A, appOwnerUserId: OWNER, status: 'paid_out', share: 250, gross: 500 },
  // APP_B is far more lucrative — so a leak is unmissable in the numbers, not just
  // in the id list.
  { appBlockId: APP_B, appOwnerUserId: OWNER, status: 'confirmed', share: 999_999, gross: 1_999_999 },
];

/**
 * A `groupBy` fake that HONOURS the `where` clause it is handed.
 *
 * 🔴 This is the instrument, so validate it before reading its verdict: a fake that
 * ignored `where.appBlockId` would return everything to everybody and make the leak
 * assertions fail even for a correct implementation — or, worse, a fake that returned
 * a hardcoded single row would make them PASS for a leaking one. The positive/negative
 * control test at the bottom of this describe exercises both directions.
 */
function wireGroupBy() {
  mockDb.blockBuzzAttribution.groupBy.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { appBlockId?: { in?: string[] }; status?: { in?: string[] } } })
      .where;
    const allowed = w.appBlockId?.in;
    const statuses = w.status?.in ?? ['confirmed', 'paid_out'];
    const rows = LEDGER.filter(
      (r) => (allowed === undefined || allowed.includes(r.appBlockId)) && statuses.includes(r.status)
    );
    const acc = new Map<string, { appBlockId: string; appOwnerUserId: number; share: number; n: number }>();
    for (const r of rows) {
      const k = `${r.appBlockId}:${r.appOwnerUserId}`;
      const prev = acc.get(k) ?? {
        appBlockId: r.appBlockId,
        appOwnerUserId: r.appOwnerUserId,
        share: 0,
        n: 0,
      };
      acc.set(k, { ...prev, share: prev.share + r.share, n: prev.n + 1 });
    }
    return [...acc.values()].map((v) => ({
      appBlockId: v.appBlockId,
      appOwnerUserId: v.appOwnerUserId,
      _sum: { appOwnerShareCents: v.share },
      _count: v.n,
    }));
  });
}

/** An `aggregate` fake that honours appBlockId + appOwnerUserId + status. */
function wireAggregate() {
  mockDb.blockBuzzAttribution.aggregate.mockImplementation(async (args: unknown) => {
    const w = (args as {
      where: { appBlockId?: string; appOwnerUserId?: number; status?: string };
    }).where;
    const rows = LEDGER.filter(
      (r) =>
        (w.appBlockId === undefined || r.appBlockId === w.appBlockId) &&
        (w.appOwnerUserId === undefined || r.appOwnerUserId === w.appOwnerUserId) &&
        (w.status === undefined || r.status === w.status)
    );
    return {
      _count: rows.length,
      _sum: {
        usdAmountCents: rows.reduce((s, r) => s + r.gross, 0),
        appOwnerShareCents: rows.reduce((s, r) => s + r.share, 0),
      },
    };
  });
}

/** Owner owns both apps; the editor holds an ACCEPTED seat on APP_A only. */
function wireAccess() {
  mockDb.appBlock.findUnique.mockImplementation(async (args: unknown) => {
    const id = (args as { where: { id: string } }).where.id;
    if (id !== APP_A && id !== APP_B) return null;
    return { id, app: { userId: OWNER } };
  });
  mockDb.appBlock.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: Record<string, unknown> }).where;
    if ((w as { app?: { userId: number } }).app) {
      return (w as { app: { userId: number } }).app.userId === OWNER
        ? [{ id: APP_A, app: { userId: OWNER } }, { id: APP_B, app: { userId: OWNER } }]
        : [];
    }
    const ids = (w as { id?: { in: string[] } }).id?.in ?? [];
    return ids.map((id) => ({ id, app: { userId: OWNER } }));
  });
  mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { appBlockId: string; userId: number; status?: string } }).where;
    const ok = w.appBlockId === APP_A && w.userId === EDITOR && w.status === 'accepted';
    return ok ? { userId: EDITOR } : null;
  });
  mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { userId?: number; status?: string } }).where;
    return w.userId === EDITOR && w.status === 'accepted' ? [{ appBlockId: APP_A }] : [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireAccess();
  wireGroupBy();
  wireAggregate();
});

describe('getMyAppsEarnings — 🔴 the editor must never see the owner’s other app', () => {
  it('INSTRUMENT CONTROLS: the groupBy fake both filters and can return multiple apps', async () => {
    // POSITIVE — an unrestricted call sees BOTH apps (so a later "only APP_A" result is
    // a fact about the code, not about a fake that can only ever return one row).
    const all = (await mockDb.blockBuzzAttribution.groupBy({
      where: { status: { in: ['confirmed', 'paid_out'] } },
    })) as Array<{ appBlockId: string; _count: number }>;
    // Grouped by (appBlockId, appOwnerUserId), so APP_A's two rows collapse to ONE
    // group of count 2 — asserting the count too proves the fake really aggregates
    // rather than returning a canned pair.
    expect(all.map((r) => r.appBlockId).sort()).toEqual([APP_A, APP_B]);
    expect(all.find((r) => r.appBlockId === APP_A)!._count).toBe(2);
    // NEGATIVE — the filter genuinely bites: APP_B disappears when excluded.
    const only = (await mockDb.blockBuzzAttribution.groupBy({
      where: { appBlockId: { in: [APP_A] }, status: { in: ['confirmed', 'paid_out'] } },
    })) as Array<{ appBlockId: string }>;
    expect(only.map((r) => r.appBlockId)).toEqual([APP_A]);
  });

  it('the OWNER sees both of their apps', async () => {
    const rows = await getMyAppsEarnings({ userId: OWNER });
    expect(rows.map((r) => r.appBlockId).sort()).toEqual([APP_A, APP_B].sort());
    expect(rows.every((r) => r.role === 'owner')).toBe(true);
  });

  it('🔴 the EDITOR sees ONLY the shared app — APP_B is absent', async () => {
    const rows = await getMyAppsEarnings({ userId: EDITOR });
    const ids = rows.map((r) => r.appBlockId);
    expect(ids).toEqual([APP_A]);
    // Stated as its own assertion so the failure message names the leak directly.
    expect(ids).not.toContain(APP_B);
  });

  it('🔴 the EDITOR’s totals equal APP_A’s alone — not the portfolio total', async () => {
    // A leak that returned the right id list but the wrong SUM would pass the id
    // assertion above. Pin the number too.
    const rows = await getMyAppsEarnings({ userId: EDITOR });
    expect(rows).toHaveLength(1);
    expect(rows[0].lifetimeShareCents).toBe(750); // 500 confirmed + 250 paid_out
    expect(rows[0].lifetimeShareCents).not.toBe(750 + 999_999);
    expect(rows[0].role).toBe('editor');
  });

  it('a stranger sees nothing', async () => {
    expect(await getMyAppsEarnings({ userId: STRANGER })).toEqual([]);
  });

  it('🔴 STRUCTURAL: the groupBy is filtered by `appBlockId IN <permitted set>`', async () => {
    // A mutation sweep showed the id-list assertions alone SURVIVE removal of this
    // filter, because the final `allIds.map` is a second, independent barrier that
    // hides the leak in the OUTPUT while the QUERY still fetched the owner's whole
    // portfolio. Defence in depth is good; relying on it to be the only guard is not —
    // the rows are in memory either way, and the next refactor of that map re-opens it.
    await getMyAppsEarnings({ userId: EDITOR });
    const args = mockDb.blockBuzzAttribution.groupBy.mock.calls[0][0] as {
      where: { appBlockId?: { in: string[] }; appOwnerUserId?: number };
    };
    expect(args.where.appBlockId, 'the app-scope filter must be present').toBeDefined();
    expect(args.where.appBlockId!.in).toEqual([APP_A]);
    expect(args.where.appBlockId!.in).not.toContain(APP_B);
    // …and NEVER an appOwnerUserId-only filter, which is the user-wide axis.
    expect(args.where.appOwnerUserId).toBeUndefined();
  });

  it('🔴 pre-transfer rows attributed to a PREVIOUS owner are excluded', async () => {
    // The transfer decision leaves `appOwnerUserId` alone, so an app-scoped query on
    // appBlockId ALONE would show the new owner the old owner's money. The second
    // scope axis (current owner) is what stops that.
    mockDb.blockBuzzAttribution.groupBy.mockResolvedValue([
      { appBlockId: APP_A, appOwnerUserId: OWNER, _sum: { appOwnerShareCents: 750 }, _count: 2 },
      // An OLD owner's rows on the same app.
      { appBlockId: APP_A, appOwnerUserId: 999, _sum: { appOwnerShareCents: 424_242 }, _count: 7 },
    ]);
    const rows = await getMyAppsEarnings({ userId: EDITOR });
    expect(rows[0].lifetimeShareCents).toBe(750);
    expect(rows[0].lifetimeCount).toBe(2);
  });
});

describe('getAppEarnings — per-app, fail-closed', () => {
  it('the owner reads the app’s summary', async () => {
    const res = await getAppEarnings({ appBlockId: APP_A, userId: OWNER });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.role).toBe('owner');
    expect(res.summary.confirmed.shareCents).toBe(500);
    expect(res.summary.paidOut.shareCents).toBe(250);
  });

  it('the accepted editor reads the SHARED app’s summary', async () => {
    const res = await getAppEarnings({ appBlockId: APP_A, userId: EDITOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.role).toBe('editor');
    expect(res.summary.confirmed.shareCents).toBe(500);
  });

  it('🔴 the editor is REFUSED on the owner’s other app — and no aggregate is run', async () => {
    const res = await getAppEarnings({ appBlockId: APP_B, userId: EDITOR });
    expect(res).toEqual({ ok: false, appBlockId: APP_B, reason: 'notPermitted' });
    // Fail-closed means fail EARLY: refusing after running the query would still have
    // put the owner's numbers in memory on this request.
    expect(mockDb.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
  });

  it('🔴 refusal is `notPermitted`, NOT a zeroed summary', async () => {
    // A zero here would be indistinguishable from "this app earned nothing" — the
    // fabricated-zero trap. The discriminated union makes that unrepresentable.
    const res = await getAppEarnings({ appBlockId: APP_B, userId: STRANGER });
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty('summary');
  });

  it('a missing app is `notFound`, distinct from `notPermitted`', async () => {
    const res = await getAppEarnings({ appBlockId: 'ab_nope', userId: OWNER });
    expect(res).toEqual({ ok: false, appBlockId: 'ab_nope', reason: 'notFound' });
  });

  it('🔴 the query carries BOTH scopes (appBlockId AND the current owner)', async () => {
    // A structural assertion on the WHERE clause, because dropping either axis is the
    // leak and a numeric assertion alone would not localise which axis went missing.
    await getAppEarnings({ appBlockId: APP_A, userId: EDITOR });
    const calls = mockDb.blockBuzzAttribution.aggregate.mock.calls as Array<[{ where: Record<string, unknown> }]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect(args.where.appBlockId).toBe(APP_A);
      expect(args.where.appOwnerUserId).toBe(OWNER);
    }
  });
});
