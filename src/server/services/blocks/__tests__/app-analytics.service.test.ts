import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the Phase 0 author-analytics service. The security-critical
 * surface is ownership: a caller must only ever see analytics for app_block
 * ids resolved from AppBlock.app.userId === their id. Everything else is
 * aggregation correctness + range clamping.
 *
 * Prisma is mocked at the module boundary; the raw `$queryRaw` calls are
 * matched by sniffing the SQL text of the tagged template so each of the
 * three raw queries (installs series / runs series / distinct users) gets
 * its own canned result.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    appBlock: { findMany: vi.fn() },
    blockUserSubscription: { count: vi.fn() },
    blockSpendAttribution: { aggregate: vi.fn() },
    blockBuzzAttribution: { aggregate: vi.fn() },
    blockScopeInvocation: { count: vi.fn(), groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

// The impressions read is a ClickHouse call with its own dedicated coverage
// (app-views.service.test.ts). Here we only care that it is WIRED correctly —
// so stub the query and keep the real emptyViews/unavailableViews helpers,
// which emptyAnalytics depends on.
const { mockGetAppViews } = vi.hoisted(() => ({ mockGetAppViews: vi.fn() }));
vi.mock('../app-views.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app-views.service')>();
  return { ...actual, getAppViews: (...args: unknown[]) => mockGetAppViews(...args) };
});

// `Prisma.sql` / `Prisma.join` are used by the service to build the raw
// queries. Provide a minimal shim that records the static SQL strings so
// the $queryRaw mock can route by content.
vi.mock('@prisma/client', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
      __sql: strings.join('?'),
    }),
    join: (values: unknown[]) => ({ __join: values }),
  },
}));

import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  emptyAnalytics,
  getMyAppAnalytics,
  getOwnedAppBlockIds,
  getOwnedAppBlocks,
  installsNotApplicable,
  resolveRange,
} from '../app-analytics.service';

const OWNER_ID = 42;
const OWNED_ID = 'apb_owned';
const OWNED_ID_2 = 'apb_owned2';
const FOREIGN_ID = 'apb_someone_else';

/**
 * Manifest fixtures for the installs applicability discriminator. Shapes are
 * copied from PROD (measured 2026-08-05 against `app_blocks.manifest`): every
 * approved app declares `page.path` and carries NO `targets` key at all, while
 * the model-slot apps carry a `targets` array and no `page`.
 */
const MODEL_MANIFEST = { targets: [{ slotId: 'model.sidebar_top', priority: 100 }] };
const PAGE_MANIFEST = { page: { path: '/' } };
/** A page app that DOES list its page slot as a target — same verdict. */
const PAGE_TARGET_MANIFEST = { page: { path: '/' }, targets: [{ slotId: 'app.page' }] };

function routeQueryRaw() {
  // The three raw queries are distinguished by a unique table token in
  // their SQL text.
  mockDbRead.$queryRaw.mockImplementation((arg: { __sql?: string }) => {
    const sql = arg?.__sql ?? '';
    if (sql.includes('block_user_subscriptions')) {
      return Promise.resolve([
        { bucket: new Date('2026-06-01T00:00:00Z'), value: 3n },
        { bucket: new Date('2026-06-02T00:00:00Z'), value: 5n },
      ]);
    }
    if (sql.includes('block_spend_attribution')) {
      return Promise.resolve([{ bucket: new Date('2026-06-01T00:00:00Z'), value: 7n }]);
    }
    if (sql.includes('block_scope_invocations')) {
      return Promise.resolve([{ value: 4n }]); // distinct users
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caller owns two INSTALLABLE (model-slot) apps, so the installs
  // counters in every generic test below are a real measurement and the
  // applicability discriminator stays off. The page-app cases override this.
  mockDbRead.appBlock.findMany.mockResolvedValue([
    { id: OWNED_ID, manifest: MODEL_MANIFEST },
    { id: OWNED_ID_2, manifest: MODEL_MANIFEST },
  ]);
  mockDbRead.blockUserSubscription.count
    .mockResolvedValueOnce(20) // installs total
    .mockResolvedValueOnce(12); // installs active
  mockDbRead.blockSpendAttribution.aggregate.mockResolvedValue({
    _count: 7,
    _sum: { buzzAmount: 7000 },
  });
  mockDbRead.blockBuzzAttribution.aggregate.mockResolvedValue({
    _count: 2,
    _sum: { buzzAmount: 5000, usdAmountCents: 999 },
  });
  // invocations: total count then error count
  mockDbRead.blockScopeInvocation.count
    .mockResolvedValueOnce(100) // apiCalls total
    .mockResolvedValueOnce(10); // status>=400
  mockDbRead.blockScopeInvocation.groupBy
    .mockResolvedValueOnce([
      { scope: 'ai:write:budgeted', _count: 60 },
      { scope: 'models:read', _count: 40 },
    ])
    .mockResolvedValueOnce([{ endpoint: '/api/v1/foo', _count: 70 }]);
  // Distinct values so a mis-wired field can't pass by coincidence.
  mockGetAppViews.mockResolvedValue({
    count: 124,
    uniqueViewers: 12,
    anonCount: 40,
  });
  routeQueryRaw();
});

describe('resolveRange', () => {
  const now = new Date('2026-06-21T00:00:00Z');

  it('defaults to the last DEFAULT_RANGE_DAYS at day granularity', () => {
    const r = resolveRange({ now });
    expect(r.to.getTime()).toBe(now.getTime());
    const spanDays = (r.to.getTime() - r.from.getTime()) / (24 * 3600 * 1000);
    expect(spanDays).toBeCloseTo(DEFAULT_RANGE_DAYS, 5);
    expect(r.granularity).toBe('day');
  });

  it('switches to week granularity for ranges over 60 days', () => {
    const from = new Date(now.getTime() - 120 * 24 * 3600 * 1000);
    const r = resolveRange({ from, to: now, now });
    expect(r.granularity).toBe('week');
  });

  it('caps the range at MAX_RANGE_DAYS', () => {
    const from = new Date(now.getTime() - 5 * 365 * 24 * 3600 * 1000);
    const r = resolveRange({ from, to: now, now });
    const spanDays = (r.to.getTime() - r.from.getTime()) / (24 * 3600 * 1000);
    expect(spanDays).toBeLessThanOrEqual(MAX_RANGE_DAYS + 0.001);
  });

  it('clamps a future `to` down to now', () => {
    const future = new Date(now.getTime() + 10 * 24 * 3600 * 1000);
    const r = resolveRange({ to: future, now });
    expect(r.to.getTime()).toBe(now.getTime());
  });

  it('falls back to default when from > to', () => {
    const from = new Date('2026-06-20T00:00:00Z');
    const to = new Date('2026-06-10T00:00:00Z');
    const r = resolveRange({ from, to, now });
    expect(r.from.getTime()).toBeLessThan(r.to.getTime());
  });
});

describe('getOwnedAppBlockIds (ownership resolution)', () => {
  it('returns all owned ids when no specific id is requested', async () => {
    const ids = await getOwnedAppBlockIds({ ownerUserId: OWNER_ID });
    expect(ids).toEqual([OWNED_ID, OWNED_ID_2]);
    expect(mockDbRead.appBlock.findMany).toHaveBeenCalledWith({
      where: { app: { userId: OWNER_ID } },
      // `manifest` rides along on this one query — the installs applicability
      // discriminator needs it, and getMyAppAnalytics is on a per-app fan-out
      // path where a second round trip would be paid N times per page load.
      select: { id: true, manifest: true },
    });
  });

  it('returns the single requested id when the caller owns it', async () => {
    const ids = await getOwnedAppBlockIds({ ownerUserId: OWNER_ID, appBlockId: OWNED_ID });
    expect(ids).toEqual([OWNED_ID]);
  });

  it('returns [] when the requested id is NOT owned (no cross-owner leak)', async () => {
    const ids = await getOwnedAppBlockIds({ ownerUserId: OWNER_ID, appBlockId: FOREIGN_ID });
    expect(ids).toEqual([]);
  });
});

describe('getMyAppAnalytics (aggregation)', () => {
  it('aggregates installs, runs+buzz, purchased and engagement correctly', async () => {
    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect(result.notOwned).toBe(false);
    // installs
    expect(result.installs.total).toBe(20);
    expect(result.installs.active).toBe(12);
    expect(result.installs.series).toEqual([
      { bucket: '2026-06-01T00:00:00.000Z', value: 3 },
      { bucket: '2026-06-02T00:00:00.000Z', value: 5 },
    ]);
    // runs + buzz spent
    expect(result.runs.count).toBe(7);
    expect(result.runs.buzzSpent).toBe(7000);
    expect(result.runs.series).toEqual([{ bucket: '2026-06-01T00:00:00.000Z', value: 7 }]);
    // buzz purchased
    expect(result.buzzPurchased.count).toBe(2);
    expect(result.buzzPurchased.buzzAmount).toBe(5000);
    expect(result.buzzPurchased.grossCents).toBe(999);
    // engagement
    expect(result.engagement.apiCalls).toBe(100);
    expect(result.engagement.activeUsers).toBe(4);
    expect(result.engagement.errorRate).toBeCloseTo(0.1, 5);
    expect(result.engagement.topScopes).toEqual([
      { scope: 'ai:write:budgeted', count: 60 },
      { scope: 'models:read', count: 40 },
    ]);
    expect(result.engagement.topEndpoints).toEqual([{ endpoint: '/api/v1/foo', count: 70 }]);
  });

  it('reports a zero error rate when there are no API calls', async () => {
    // Override invocation counts: 0 total, 0 errors.
    mockDbRead.blockScopeInvocation.count.mockReset();
    mockDbRead.blockScopeInvocation.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const result = await getMyAppAnalytics({ userId: OWNER_ID });
    expect(result.engagement.apiCalls).toBe(0);
    expect(result.engagement.errorRate).toBe(0);
  });

  it('passes the owned id set into the aggregate where-clauses', async () => {
    await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });
    // spend aggregate should be scoped to the single owned id
    const spendArgs = mockDbRead.blockSpendAttribution.aggregate.mock.calls[0][0];
    expect(spendArgs.where.appBlockId).toEqual({ in: [OWNED_ID] });
    expect(spendArgs.where.attributedAt).toHaveProperty('gte');
    expect(spendArgs.where.attributedAt).toHaveProperty('lte');
  });
});

describe('getMyAppAnalytics (ownership enforcement)', () => {
  it('returns zeroed analytics with notOwned=true for a non-owned id', async () => {
    const result = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: FOREIGN_ID });
    expect(result.notOwned).toBe(true);
    expect(result.installs.total).toBe(0);
    expect(result.runs.count).toBe(0);
    expect(result.buzzPurchased.count).toBe(0);
    expect(result.engagement.apiCalls).toBe(0);
    // CRITICAL: none of the aggregate queries ran — no foreign data touched.
    expect(mockDbRead.blockSpendAttribution.aggregate).not.toHaveBeenCalled();
    expect(mockDbRead.blockBuzzAttribution.aggregate).not.toHaveBeenCalled();
    expect(mockDbRead.blockScopeInvocation.count).not.toHaveBeenCalled();
  });

  it('returns empty (notOwned=false) when the caller owns nothing', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([]);
    const result = await getMyAppAnalytics({ userId: OWNER_ID });
    expect(result.notOwned).toBe(false);
    expect(result.installs.total).toBe(0);
    expect(mockDbRead.blockSpendAttribution.aggregate).not.toHaveBeenCalled();
  });

  // The RECORDED DECISION, pinned at the service boundary so it cannot drift
  // back: owning no apps is a truthful measured zero, so the payload carries no
  // `unavailable` discriminator. `notEntitled` / `notOwned` mean "we never ran
  // the query"; this path skips the aggregates only because their answer over
  // an empty owned set is already known to be zero. The sibling case lives in
  // `emptyAnalytics` above — this one pins that getMyAppAnalytics actually
  // reaches it, which the helper tests cannot show.
  it('does NOT flag the owns-nothing payload as unavailable', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([]);

    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect(result.unavailable).toBeUndefined();
    expect('unavailable' in result).toBe(false);
    // `views` has its own flag and tracks the payload's (#3613), so it stays
    // unflagged here too — an author who owns nothing has genuinely had zero
    // impressions, not unmeasurable ones.
    expect(result.views.unavailable).toBeUndefined();
    expect('unavailable' in result.views).toBe(false);
  });
});

describe('emptyAnalytics (measurement vs placeholder discriminator)', () => {
  const range = { from: new Date(0), to: new Date(0), granularity: 'day' as const };

  it('flags a non-owned placeholder', () => {
    expect(emptyAnalytics(range, true).unavailable).toBe('notOwned');
  });

  it('flags an explicit not-entitled placeholder (the dark-flag caller)', () => {
    expect(emptyAnalytics(range, false, 'notEntitled').unavailable).toBe('notEntitled');
  });

  it('leaves a genuine zero UNflagged', () => {
    expect(emptyAnalytics(range, false).unavailable).toBeUndefined();
    expect('unavailable' in emptyAnalytics(range, false)).toBe(false);
  });

  // The `views` section carries its OWN unavailable flag (ClickHouse can be
  // down while Postgres is fine), so it has to track the payload-level one on
  // these placeholder paths or a client sees a flagged payload whose
  // impressions claim to be measured.
  it('propagates the placeholder verdict into views', () => {
    expect(emptyAnalytics(range, true).views.unavailable).toBe(true);
    expect(emptyAnalytics(range, false, 'notEntitled').views.unavailable).toBe(true);
  });

  it('leaves views UNflagged when the payload is a genuine zero', () => {
    // "You own no apps" is a truthful measured zero for impressions too.
    const views = emptyAnalytics(range, false).views;
    expect(views.unavailable).toBeUndefined();
    expect('unavailable' in views).toBe(false);
    expect(views).toEqual({ count: 0, uniqueViewers: 0, anonCount: 0 });
  });
});

describe('getMyAppAnalytics (impressions wiring)', () => {
  it('passes the OWNED ids and the resolved range to the impressions read', async () => {
    const from = new Date('2026-06-01T00:00:00Z');
    const to = new Date('2026-06-21T00:00:00Z');

    await getMyAppAnalytics({ userId: OWNER_ID, from, to });

    expect(mockGetAppViews).toHaveBeenCalledTimes(1);
    const arg = mockGetAppViews.mock.calls[0][0];
    // Ownership is enforced ONCE, upstream — the reader is handed resolved
    // ids and applies no check of its own, so handing it anything else (the
    // requested id, say) would be a data leak across authors.
    expect(arg.appBlockIds).toEqual([OWNED_ID, OWNED_ID_2]);
    expect(arg.from.getTime()).toBe(from.getTime());
    expect(arg.to.getTime()).toBe(to.getTime());
    // No `granularity`: the impressions read is a single rollup with no time
    // series, so a bucket size would be dead weight passed across the seam.
    expect(arg.granularity).toBeUndefined();
  });

  it('narrows the impressions read to a single requested owned id', async () => {
    await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });

    expect(mockGetAppViews.mock.calls[0][0].appBlockIds).toEqual([OWNED_ID]);
  });

  it('never calls the impressions read for a foreign id', async () => {
    await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: FOREIGN_ID });

    expect(mockGetAppViews).not.toHaveBeenCalled();
  });

  it('returns the impressions payload verbatim', async () => {
    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect(result.views).toEqual({
      count: 124,
      uniqueViewers: 12,
      anonCount: 40,
    });
  });

  it('carries an impressions outage through without touching the other counters', async () => {
    mockGetAppViews.mockResolvedValue({
      count: 0,
      uniqueViewers: 0,
      anonCount: 0,
      unavailable: true,
    });

    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect(result.views.unavailable).toBe(true);
    // The whole reason views has its OWN flag: ClickHouse being down says
    // nothing about the Postgres-derived numbers, which stay measured.
    expect(result.unavailable).toBeUndefined();
    expect(result.installs.total).toBe(20);
    expect(result.runs.count).toBe(7);
  });

  it('still passes the CLAMPED range on a long request', async () => {
    // The reader has no bucket size to pick any more, but it must still see the
    // range the rest of the payload was computed over, or the impression count
    // would cover a different window than the counters beside it.
    const to = new Date('2026-06-21T00:00:00Z');
    const from = new Date(to.getTime() - 120 * 24 * 3600 * 1000);

    await getMyAppAnalytics({ userId: OWNER_ID, from, to });

    const arg = mockGetAppViews.mock.calls[0][0];
    expect(arg.from.getTime()).toBe(from.getTime());
    expect(arg.to.getTime()).toBe(to.getTime());
  });
});

describe('getMyAppAnalytics (fabricated-zero discriminator)', () => {
  it('a non-owned id is flagged unavailable; a measured empty app is not', async () => {
    const notOwned = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: FOREIGN_ID });
    expect(notOwned.unavailable).toBe('notOwned');

    // Owned app, every aggregate legitimately returns zero — a REAL measurement
    // of "no activity yet". It must stay unflagged, otherwise the UI hides a
    // dashboard the author is entitled to see.
    // mockReset first: the beforeEach queues `mockResolvedValueOnce` values that
    // the short-circuiting notOwned call above never consumed, and a queued
    // Once wins over mockResolvedValue.
    mockDbRead.blockUserSubscription.count.mockReset();
    mockDbRead.blockUserSubscription.count.mockResolvedValue(0);
    mockDbRead.blockSpendAttribution.aggregate.mockReset();
    mockDbRead.blockSpendAttribution.aggregate.mockResolvedValue({
      _count: 0,
      _sum: { buzzAmount: null },
    });
    mockDbRead.blockBuzzAttribution.aggregate.mockReset();
    mockDbRead.blockBuzzAttribution.aggregate.mockResolvedValue({
      _count: 0,
      _sum: { buzzAmount: null, usdAmountCents: null },
    });
    mockDbRead.blockScopeInvocation.count.mockReset();
    mockDbRead.blockScopeInvocation.count.mockResolvedValue(0);
    mockDbRead.blockScopeInvocation.groupBy.mockReset();
    mockDbRead.blockScopeInvocation.groupBy.mockResolvedValue([]);
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);

    const measured = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });
    expect(measured.unavailable).toBeUndefined();
    expect(measured.notOwned).toBe(false);

    // Same all-zero counters on both sides — the discriminator is the only signal.
    expect(measured.installs).toEqual(notOwned.installs);
    expect(measured.runs).toEqual(notOwned.runs);
    expect(measured.engagement).toEqual(notOwned.engagement);
  });
});

/**
 * INSTALLS APPLICABILITY — the THIRD state, kept distinct from the other two.
 *
 * 1. measured non-zero — a model-slot app with installs;
 * 2. measured zero     — a model-slot app with none YET. Must still render 0;
 * 3. not applicable    — a page app, where an install row CANNOT exist.
 *
 * (3) collapsing into (2) is the defect this fixes. (2) collapsing into (3) is
 * the regression it must not introduce, and is the one that would go silent:
 * every visible symptom would look like the fix working.
 */
describe('installsNotApplicable (the three-state predicate)', () => {
  it('(3) flags a set whose every app is page-only', () => {
    expect(
      installsNotApplicable({ ownedApps: [{ manifest: PAGE_MANIFEST }], total: 0, active: 0 })
    ).toBe(true);
  });

  it('(3) flags a page app that lists app.page as an explicit target', () => {
    expect(
      installsNotApplicable({
        ownedApps: [{ manifest: PAGE_TARGET_MANIFEST }],
        total: 0,
        active: 0,
      })
    ).toBe(true);
  });

  it('(2) does NOT flag a model-slot app with a truthful zero', () => {
    expect(
      installsNotApplicable({ ownedApps: [{ manifest: MODEL_MANIFEST }], total: 0, active: 0 })
    ).toBe(false);
  });

  it('(1) does NOT flag a model-slot app with installs', () => {
    expect(
      installsNotApplicable({ ownedApps: [{ manifest: MODEL_MANIFEST }], total: 3, active: 1 })
    ).toBe(false);
  });

  // The state-(1) guard. Not hypothetical: upsertSubscription applies no slot
  // check and assertLaunchAppForCaller admits any page-declaring app, so a row
  // CAN exist against a stateless app. If one does, the author must see the
  // number rather than an "n/a" that hides it.
  it('(1) NEVER hides a non-zero count behind "not applicable", even for a page app', () => {
    expect(
      installsNotApplicable({ ownedApps: [{ manifest: PAGE_MANIFEST }], total: 2, active: 0 })
    ).toBe(false);
    // `active` alone is enough — a disabled-but-present install is still a row.
    expect(
      installsNotApplicable({ ownedApps: [{ manifest: PAGE_MANIFEST }], total: 0, active: 2 })
    ).toBe(false);
  });

  // "All my apps": one installable app makes the aggregate a real measurement.
  it('does NOT flag a MIXED set (one page app + one model app)', () => {
    expect(
      installsNotApplicable({
        ownedApps: [{ manifest: PAGE_MANIFEST }, { manifest: MODEL_MANIFEST }],
        total: 0,
        active: 0,
      })
    ).toBe(false);
    // Order-independent — `some`, not "look at the first one".
    expect(
      installsNotApplicable({
        ownedApps: [{ manifest: MODEL_MANIFEST }, { manifest: PAGE_MANIFEST }],
        total: 0,
        active: 0,
      })
    ).toBe(false);
  });

  it('flags a set of SEVERAL page apps (every one inapplicable)', () => {
    expect(
      installsNotApplicable({
        ownedApps: [{ manifest: PAGE_MANIFEST }, { manifest: PAGE_TARGET_MANIFEST }],
        total: 0,
        active: 0,
      })
    ).toBe(true);
  });

  // An empty set is not a claim about anything. The owns-nothing / notOwned
  // payloads carry their own honesty (see emptyAnalytics); asserting
  // inapplicability on top of them would fabricate a different claim.
  it('does NOT flag an empty owned set', () => {
    expect(installsNotApplicable({ ownedApps: [], total: 0, active: 0 })).toBe(false);
  });

  // Manifest shapes that are absent or junk are page-app-shaped in the only way
  // that matters: no model target ⇒ no install affordance ⇒ no row can exist.
  it('treats a missing / malformed manifest as inapplicable', () => {
    expect(installsNotApplicable({ ownedApps: [{ manifest: null }], total: 0, active: 0 })).toBe(
      true
    );
    expect(installsNotApplicable({ ownedApps: [{}], total: 0, active: 0 })).toBe(true);
    expect(
      installsNotApplicable({ ownedApps: [{ manifest: { targets: [] } }], total: 0, active: 0 })
    ).toBe(true);
  });
});

describe('getOwnedAppBlocks (manifest resolution)', () => {
  it('returns id + manifest for every owned app', async () => {
    await expect(getOwnedAppBlocks({ ownerUserId: OWNER_ID })).resolves.toEqual([
      { id: OWNED_ID, manifest: MODEL_MANIFEST },
      { id: OWNED_ID_2, manifest: MODEL_MANIFEST },
    ]);
  });

  it('narrows to the requested id and drops a foreign one (no cross-owner leak)', async () => {
    await expect(
      getOwnedAppBlocks({ ownerUserId: OWNER_ID, appBlockId: OWNED_ID })
    ).resolves.toEqual([{ id: OWNED_ID, manifest: MODEL_MANIFEST }]);
    await expect(
      getOwnedAppBlocks({ ownerUserId: OWNER_ID, appBlockId: FOREIGN_ID })
    ).resolves.toEqual([]);
  });
});

describe('getMyAppAnalytics (installs applicability wiring)', () => {
  /** Zero every counter so `installs` is all-zero regardless of the fixture. */
  function zeroInstalls() {
    mockDbRead.blockUserSubscription.count.mockReset();
    mockDbRead.blockUserSubscription.count.mockResolvedValue(0);
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
  }

  it('(3) flags a PAGE app whose installs are structurally impossible', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([{ id: OWNED_ID, manifest: PAGE_MANIFEST }]);
    zeroInstalls();

    const result = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });

    expect(result.installs.notApplicable).toBe(true);
    // The counters still ride along (a client may want them) — the flag is what
    // says not to read them as behaviour.
    expect(result.installs.total).toBe(0);
    expect(result.installs.active).toBe(0);
    // PER-SECTION: the rest of the payload is genuinely measured and unflagged.
    expect(result.unavailable).toBeUndefined();
    expect(result.notOwned).toBe(false);
    expect(result.views.unavailable).toBeUndefined();
  });

  // 🔴 The regression that would go silent. A model-slot app with no installs
  // yet is a REAL zero and must arrive with NO flag at all — not `false`, so a
  // client cannot tell it apart from an old server only by the key's absence.
  it('(2) leaves a model-slot app with a truthful zero UNflagged', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([{ id: OWNED_ID, manifest: MODEL_MANIFEST }]);
    zeroInstalls();

    const result = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });

    expect(result.installs.total).toBe(0);
    expect(result.installs.active).toBe(0);
    expect(result.installs.notApplicable).toBeUndefined();
    expect('notApplicable' in result.installs).toBe(false);
  });

  it('(1) leaves a model-slot app WITH installs unflagged and reports the count', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([{ id: OWNED_ID, manifest: MODEL_MANIFEST }]);

    const result = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });

    expect(result.installs.total).toBe(20);
    expect(result.installs.active).toBe(12);
    expect('notApplicable' in result.installs).toBe(false);
  });

  it('(1) reports a page app that somehow HAS rows, rather than hiding them', async () => {
    // The write hole is real (see assertLaunchAppForCaller): a page app can take
    // a block_user_subscriptions row. If one exists the author sees the number.
    mockDbRead.appBlock.findMany.mockResolvedValue([{ id: OWNED_ID, manifest: PAGE_MANIFEST }]);

    const result = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: OWNED_ID });

    expect(result.installs.total).toBe(20);
    expect(result.installs.active).toBe(12);
    expect('notApplicable' in result.installs).toBe(false);
  });

  it('does not flag the "All my apps" read when ONE owned app is installable', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([
      { id: OWNED_ID, manifest: PAGE_MANIFEST },
      { id: OWNED_ID_2, manifest: MODEL_MANIFEST },
    ]);
    zeroInstalls();

    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect('notApplicable' in result.installs).toBe(false);
  });

  it('flags the "All my apps" read when EVERY owned app is page-only', async () => {
    mockDbRead.appBlock.findMany.mockResolvedValue([
      { id: OWNED_ID, manifest: PAGE_MANIFEST },
      { id: OWNED_ID_2, manifest: PAGE_MANIFEST },
    ]);
    zeroInstalls();

    const result = await getMyAppAnalytics({ userId: OWNER_ID });

    expect(result.installs.notApplicable).toBe(true);
  });

  // The two placeholder payloads make a DIFFERENT claim ("we never asked"), and
  // neither resolved a manifest, so neither may assert inapplicability on top.
  it('never flags the notOwned / owns-nothing placeholders', async () => {
    const notOwned = await getMyAppAnalytics({ userId: OWNER_ID, appBlockId: FOREIGN_ID });
    expect(notOwned.unavailable).toBe('notOwned');
    expect('notApplicable' in notOwned.installs).toBe(false);

    mockDbRead.appBlock.findMany.mockResolvedValue([]);
    const ownsNothing = await getMyAppAnalytics({ userId: OWNER_ID });
    expect(ownsNothing.unavailable).toBeUndefined();
    expect('notApplicable' in ownsNothing.installs).toBe(false);
  });

  it('never flags the notEntitled placeholder', () => {
    const range = { from: new Date(0), to: new Date(0), granularity: 'day' as const };
    const notEntitled = emptyAnalytics(range, false, 'notEntitled');
    expect(notEntitled.unavailable).toBe('notEntitled');
    expect('notApplicable' in notEntitled.installs).toBe(false);
  });
});
