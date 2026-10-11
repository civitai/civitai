import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Phase 0 author-analytics proc — gate + delegation + input validation.
 *
 * Same mock skeleton as blocks.router.flag-gate.test.ts (heavy services
 * stubbed so importing the router doesn't drag in the stale generated
 * Prisma client). The analytics SERVICE is mocked at the boundary — this
 * test asserts the ROUTER wiring:
 *   - appDeveloperProcedure (the `appBlocksAuthor` capability) + enforceAppBlocksFlag
 *     gate (non-author / anon rejected, dark behind the appBlocks flag);
 *   - the caller's session user id is threaded into the service (ownership is
 *     enforced inside the service, covered by app-analytics.service.test.ts);
 *   - the zod input is validated (appBlockId length cap, from/to datetime).
 */

const {
  mockIsAppBlocksEnabled,
  mockGetMyAppAnalytics,
  mockGetRevenueForOwner,
  mockGetRecentAttributionsForOwner,
  mockGetGoodsSalesForOwner,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetMyAppAnalytics: vi.fn(),
  mockGetRevenueForOwner: vi.fn(),
  mockGetRecentAttributionsForOwner: vi.fn(),
  mockGetGoodsSalesForOwner: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/services/blocks/app-analytics.service', () => ({
  getMyAppAnalytics: (...a: unknown[]) => mockGetMyAppAnalytics(...a),
  // emptyAnalytics + resolveRange are pure (no DB) — use the real ones so the
  // flag-off short-circuit returns the genuine zeroed shape.
  emptyAnalytics: (
    range: unknown,
    notOwned: boolean,
    unavailable: string | undefined = notOwned ? 'notOwned' : undefined
  ) => ({
    range,
    notOwned,
    ...(unavailable ? { unavailable } : {}),
    installs: { total: 0, active: 0, series: [] },
    runs: { count: 0, buzzSpent: 0, series: [] },
    buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
    engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
  }),
  resolveRange: () => ({ from: new Date(0), to: new Date(0), granularity: 'day' as const }),
}));
// 🔴 SPREAD + OVERRIDES, not a hand-listed factory. This suite DOES assert revenue, so it
// needs the three reads stubbed — but a factory that lists only those fails to LOAD the
// moment `blocks.router` imports one more export from this module: in CI, in a file nobody
// was looking at, with a green typecheck. It already had to be edited twice for exactly
// that (`getGoodsSalesForOwner`, then `unreadableGoodsSales` + `isMissingGoodsTableError`).
//
// The spread also keeps the PURE helpers real, which is strictly better than copying them:
// the unreadable-path test below then exercises the actual `unreadableGoodsSales()` shape
// and the actual `isMissingGoodsTableError` predicate, so neither can drift from the copy
// a hand-listed factory would have had to carry. `emptyRevenue()` is real for the same
// reason — it is the function whose `unavailable` discriminator the flag-off test asserts.
vi.mock('~/server/services/blocks/buzz-attribution.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getRevenueForOwner: (...a: unknown[]) => mockGetRevenueForOwner(...a),
  getRecentAttributionsForOwner: (...a: unknown[]) => mockGetRecentAttributionsForOwner(...a),
  getGoodsSalesForOwner: (...a: unknown[]) => mockGetGoodsSalesForOwner(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...a: unknown[]) => mockGetUserById(...a),
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockRedis = redisMock.redis;
const mockSysRedis = redisMock.sysRedis;
const mockLogToAxiom = loggingMock.logToAxiom;

function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
  return Promise.resolve(!!opts?.user?.isModerator);
}

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: !!(user as { isModerator?: boolean })?.isModerator } as never,
    track: undefined,
  };
}

const modUser = { id: 1, isModerator: true, tier: 'free', username: 'mod' };
const normalUser = { id: 2, isModerator: false, tier: 'free', username: 'user' };

const SENTINEL = {
  range: { from: new Date(), to: new Date(), granularity: 'day' as const },
  notOwned: false,
  installs: { total: 0, active: 0, series: [] },
  runs: { count: 0, buzzSpent: 0, series: [] },
  buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
  engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockGetMyAppAnalytics.mockReset();
  mockGetMyAppAnalytics.mockResolvedValue(SENTINEL);
  mockGetRevenueForOwner.mockReset();
  mockGetRevenueForOwner.mockResolvedValue({ summary: {}, topApps: [] });
  mockGetRecentAttributionsForOwner.mockReset();
  mockGetRecentAttributionsForOwner.mockResolvedValue([]);
  mockGetGoodsSalesForOwner.mockReset();
  mockGetGoodsSalesForOwner.mockResolvedValue({
    sales: {
      count: 0,
      grossBuzz: 0,
      shareBuzz: 0,
      shareUsdCents: 0,
      grossUsdCents: 0,
      blueGrossBuzz: 0,
    },
    refunded: { count: 0, grossBuzz: 0 },
  });
});

describe('getMyAppAnalytics — gate', () => {
  it('moderator: gate passes, service called with the session user id', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppAnalytics({ appBlockId: 'apb_1' });
    expect(result).toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
    const args = mockGetMyAppAnalytics.mock.calls[0][0];
    expect(args.userId).toBe(modUser.id);
    expect(args.appBlockId).toBe('apb_1');
  });

  it('non-moderator: rejected before the service runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getMyAppAnalytics({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('anonymous: rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getMyAppAnalytics({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('flag OFF (even for a moderator): returns zeroed analytics + runs NO aggregate', async () => {
    // Two DIFFERENT gates, both keyed off isModerator by different code — hence the
    // "moderator" test names. appDeveloperProcedure passes because `hasAppBlocksAuthor`
    // reads `getFeatureFlags(ctx).appBlocksAuthor`, which this file does NOT mock, so it
    // resolves from the static `availability: ['mod']` fallback against
    // `modUser.isModerator`. Separately `fakePerUserFlag` mocks `isAppBlocksEnabled` —
    // the DARK flag — and here it is forced OFF →
    // enforceAppBlocksFlag marks _appBlocksDisabled on the query ctx → the proc
    // short-circuits to the empty shape and never touches the aggregate service.
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppAnalytics({ appBlockId: 'apb_1' });
    expect(result.installs).toEqual({ total: 0, active: 0, series: [] });
    expect(result.runs).toEqual({ count: 0, buzzSpent: 0, series: [] });
    expect(result.buzzPurchased).toEqual({ count: 0, buzzAmount: 0, grossCents: 0 });
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('flag OFF: the zeroed payload is FLAGGED unavailable, not passed off as data', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyAppAnalytics({ appBlockId: 'apb_1' });
    expect(result.unavailable).toBe('notEntitled');
    // Fail-closed on the legacy field too: a client that only guards on
    // `notOwned` (civitai/cli#190) must refuse to render this payload.
    expect(result.notOwned).toBe(true);
  });

  it('DISCRIMINATOR: a dark-flag zero is distinguishable from a genuine owned-but-empty zero', async () => {
    // Both payloads have byte-identical all-zero counters and the same range —
    // that is exactly the confusion this proc used to ship. The ONLY thing a
    // client can branch on is the discriminator, so pin it from both sides.
    const range = { from: new Date(0), to: new Date(0), granularity: 'day' as const };
    const genuineZero = {
      range,
      notOwned: false,
      installs: { total: 0, active: 0, series: [] },
      runs: { count: 0, buzzSpent: 0, series: [] },
      buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
      engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
    };
    mockGetMyAppAnalytics.mockResolvedValue(genuineZero);

    const owned = await blocksRouter
      .createCaller(fakeCtx(modUser) as never)
      .getMyAppAnalytics({ appBlockId: 'apb_1' });

    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const dark = await blocksRouter
      .createCaller(fakeCtx(modUser) as never)
      .getMyAppAnalytics({ appBlockId: 'apb_1' });

    // Precondition: the counters really are identical, so nothing else could
    // tell these apart.
    expect(dark.installs).toEqual(owned.installs);
    expect(dark.runs).toEqual(owned.runs);
    expect(dark.buzzPurchased).toEqual(owned.buzzPurchased);
    expect(dark.engagement).toEqual(owned.engagement);

    // A genuinely-measured empty app is NOT flagged; the dark-flag one is.
    expect(owned.unavailable).toBeUndefined();
    expect(dark.unavailable).toBe('notEntitled');
    expect(owned.notOwned).toBe(false);
    expect(dark.notOwned).toBe(true);
    expect(dark).not.toEqual(owned);
  });
});

describe('getMyAppAnalytics — input validation & delegation', () => {
  it('threads optional from/to (parsed to Date) into the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getMyAppAnalytics({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-21T00:00:00.000Z',
    });
    const args = mockGetMyAppAnalytics.mock.calls[0][0];
    expect(args.from).toBeInstanceOf(Date);
    expect(args.to).toBeInstanceOf(Date);
    expect(args.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('rejects an over-long appBlockId (zod max 64)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'x'.repeat(65) })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('rejects a non-datetime `from`', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getMyAppAnalytics({ from: 'not-a-date' })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });
});

describe('getMyRevenue — dark-flag short-circuit', () => {
  it('flag ON (moderator): runs the revenue aggregate', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });
    expect(mockGetRevenueForOwner).toHaveBeenCalledTimes(1);
    expect(result.recentAttributions).toEqual([]);
  });

  it('flag ON: the DIGITAL-GOODS bridge runs too, scoped and returned', async () => {
    // 🔴 THE REGRESSION. Digital-goods sales record into `block_good_purchase` and
    // write no attribution row, so before this call existed a settled sale showed as
    // $0 on both revenue pages. This asserts the proc actually makes the second
    // read — and makes it with the caller's own id and the requested app scope,
    // since `appOwnerUserId` IS the authorization on that aggregate.
    mockGetGoodsSalesForOwner.mockResolvedValue({
      sales: {
        count: 1,
        grossBuzz: 10,
        shareBuzz: 7,
        shareUsdCents: 0,
        grossUsdCents: 1,
        blueGrossBuzz: 0,
      },
      refunded: { count: 0, grossBuzz: 0 },
    });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });

    expect(mockGetGoodsSalesForOwner).toHaveBeenCalledTimes(1);
    expect(mockGetGoodsSalesForOwner).toHaveBeenCalledWith({
      ownerUserId: modUser.id,
      appBlockId: 'apb_1',
      from: undefined,
      to: undefined,
    });
    // Carried through to the payload rather than computed and dropped — a value the
    // proc fetches and does not return is the invisible-revenue bug with extra steps.
    expect(result.goods.sales).toStrictEqual({
      count: 1,
      grossBuzz: 10,
      shareBuzz: 7,
      shareUsdCents: 0,
      grossUsdCents: 1,
      blueGrossBuzz: 0,
    });
  });

  it('flag ON: an explicit date range reaches BOTH date-filtered reads as Dates', async () => {
    // The range is parsed once in the resolver and handed to both aggregates. A
    // read that silently ignored `from`/`to` would report the lifetime total under
    // a period heading.
    //
    // 🔴 BOTH, not just the new one. Adding the goods branch rewrote all three call
    // sites, and `getRevenueForOwner`'s arguments were asserted NOWHERE — only its
    // call COUNT — so dropping `from`/`to` from the pre-existing attribution read
    // in that refactor would have shipped silently.
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getMyRevenue({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T00:00:00.000Z',
    });
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-30T00:00:00.000Z');
    const goodsArgs = mockGetGoodsSalesForOwner.mock.calls[0]?.[0] as { from?: Date; to?: Date };
    expect(goodsArgs.from).toEqual(from);
    expect(goodsArgs.to).toEqual(to);
    const revenueArgs = mockGetRevenueForOwner.mock.calls[0]?.[0] as { from?: Date; to?: Date };
    expect(revenueArgs.from).toEqual(from);
    expect(revenueArgs.to).toEqual(to);
  });

  it('UNREADABLE goods table: the rail is flagged, the rest of the payload survives', async () => {
    // 🔴 `block_good_purchase` is applied BY HAND per environment, so this proc can
    // run against a database without it. Unguarded, the new branch took the whole
    // of `getMyRevenue` down — including the attribution figures, which were
    // readable — so both revenue pages failed outright.
    // 🔴 THE CLASSIFICATION IS LOAD-BEARING, AND IT IS CODE **OR** MESSAGE. The
    // router degrades only on `isMissingGoodsTableError`, which now delegates to the
    // measured `isMissingTableError` in `app-access.service.ts`: Prisma's `P2021` /
    // Postgres `42P01` by CODE, or a message that NAMES the missing relation or
    // table. Both halves are needed — Prisma leaves the SQLSTATE in the message only
    // on some driver paths, and the code-only version of this predicate rethrew
    // there, 500ing both revenue pages. What it still refuses is a COLUMN error
    // (a half-applied manual migration) and anything it cannot classify; the
    // rethrow-everything-else cases below are what pin that.
    // This fixture carries both signals, as the real Prisma error does.
    mockGetGoodsSalesForOwner.mockRejectedValue(
      Object.assign(new Error('The table `block_good_purchase` does not exist'), { code: 'P2021' })
    );
    // 🔴 NON-ZERO attribution figures, deliberately. The default fixture returns an
    // empty summary, against which "the attribution half survived" is unfalsifiable —
    // a proc that dropped it entirely would look identical. These literals appear
    // nowhere else in this file, so they can only have come through intact.
    mockGetRevenueForOwner.mockResolvedValue({
      summary: { confirmed: { count: 4, grossCents: 517, shareCents: 362 } },
      topApps: [{ appBlockId: 'apb_1', shareCents: 362, count: 4 }],
    });
    mockGetRecentAttributionsForOwner.mockResolvedValue([{ id: 'bba_survivor' }]);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);

    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });

    // 🔴 FLAGGED, NOT ZEROED. Returning bare zeros here would report "no sales" for
    // a rail that was never read — the fabricated zero this surface is built to
    // prevent, which is why the catch returns `unreadableGoodsSales()`.
    expect(result.goods.unavailable).toBe('unreadable');
    expect(result.goods.sales.count).toBe(0);
    // ...and the attribution half arrives untouched: one unreadable rail must degrade
    // to a labelled gap, not take down figures that were readable.
    expect(result.summary.confirmed).toEqual({ count: 4, grossCents: 517, shareCents: 362 });
    expect(result.topApps).toEqual([{ appBlockId: 'apb_1', shareCents: 362, count: 4 }]);
    expect(result.recentAttributions).toEqual([{ id: 'bba_survivor' }]);
    // The PAYLOAD-level discriminator must stay absent: the payload is a real
    // measurement; it is one bucket inside it that could not be read.
    expect(result.unavailable).toBeUndefined();
    // 🔴 AND IT IS REPORTED. The catch's only observability is this log, and nothing
    // asserted it — so deleting the call was a green mutation, which would have made
    // a missing production table completely silent.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'block-goods-earnings', type: 'error' }),
      'civitai-prod'
    );
  });

  it('a NON-table goods failure RETHROWS — it is not laundered into "unreadable"', async () => {
    // 🔴 THE CONTROL THAT MAKES THE DEGRADATION SAFE, and the reason the catch is
    // narrow. A `.catch` that swallowed everything would report a column rename, a
    // bad argument or a `TypeError` to the owner as "sales could not be loaded" —
    // politely, in production, indefinitely. That is the invisible-revenue defect
    // this whole change fixes, re-entering through the error path: a bug that hides
    // itself behind a message the owner has no reason to question.
    mockGetGoodsSalesForOwner.mockRejectedValue(
      Object.assign(new Error('Unknown argument `bluePaidBuzz`'), {
        code: 'P2009',
      })
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);

    await expect(caller.getMyRevenue({ appBlockId: 'apb_1' })).rejects.toThrow(/Unknown argument/);
  });

  it('...and so does an error carrying no code at all', async () => {
    // A plain `TypeError` from inside the aggregate — no `code`, and a message that
    // names no relation or table. `isMissingGoodsTableError` matches on either
    // signal, so this is the shape that proves it fails CLOSED on BOTH: an error it
    // cannot classify is rethrown, never treated as the table case. (The predicate
    // no longer requires a `code` property — the message path is matched too — which
    // is why the message here must be one that carries no missing-relation signal.)
    mockGetGoodsSalesForOwner.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading '_sum')")
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);

    // tRPC wraps a thrown error as `TRPCError{ code: INTERNAL_SERVER_ERROR, cause }`, so
    // the assertion is on the OUTCOME — a loud 500 carrying the original message — not on
    // the constructor. That outcome is the point: the request fails instead of the owner
    // being told their sales could not be loaded.
    await expect(caller.getMyRevenue({ appBlockId: 'apb_1' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining("reading '_sum'"),
    });
  });

  it('DISCRIMINATOR: a measured goods result carries NO unavailable flag', async () => {
    // Byte-identical zero figures to the case above — only the discriminator
    // differs. Without this, a change that flagged every goods read would satisfy
    // the test above while telling every owner their sales could not be loaded.
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });
    expect(result.goods.sales.count).toBe(0);
    expect(result.goods.unavailable).toBeUndefined();
  });

  it('flag OFF (even for a moderator): returns zeroed revenue + runs NO query', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });
    expect(result.topApps).toEqual([]);
    expect(result.recentAttributions).toEqual([]);
    expect(result.summary.confirmed).toEqual({ count: 0, grossCents: 0, shareCents: 0 });
    expect(mockGetRevenueForOwner).not.toHaveBeenCalled();
    expect(mockGetRecentAttributionsForOwner).not.toHaveBeenCalled();
    // The goods read is behind the SAME short-circuit. A third aggregate added
    // after the guard would leak live sales to a flag-off caller while every
    // assertion above still passed.
    expect(mockGetGoodsSalesForOwner).not.toHaveBeenCalled();
    expect(result.goods.sales.count).toBe(0);
    expect(result.goods.sales.shareBuzz).toBe(0);
    // 🔴 THE POINT OF THE CHANGE, and the only assertion in CI that sits at the proc
    // boundary this contract actually ships through. Without it, the zeroed buckets
    // above are byte-identical to a publisher who genuinely earned nothing — which is
    // exactly the bug. The renderer guards live in the `component` project, which only
    // the PR preview pipeline runs — report-only and not a required check — so do not
    // delete this on the grounds that a panel test covers it.
    expect(result.unavailable).toBe('notEntitled');
  });

  it('DISCRIMINATOR: a measured revenue result is NOT flagged unavailable', async () => {
    // Byte-identical zero buckets are possible on this path too (a publisher with no
    // earnings yet), so the flag-ON case must leave `unavailable` absent. Without this,
    // a change that flagged everything would satisfy the test above and silently deny
    // every publisher their real dashboard.
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const result = await caller.getMyRevenue({ appBlockId: 'apb_1' });
    expect(result.unavailable).toBeUndefined();
    expect(mockGetRevenueForOwner).toHaveBeenCalledTimes(1);
  });
});

/**
 * OAuth token-scope gate on getMyAppAnalytics — the proc `civitai app metrics`
 * calls. It was UN-annotated, so `enforceTokenScope` implicitly required
 * `TokenScope.Full`: a personal API key worked but the `civitai login` OAuth token
 * (the CLI's default auth path) 403'd. Now
 * `.meta({ requiredScope: TokenScope.AppBlocksSubmit })` — the same bit
 * `GET /api/v1/blocks/submissions` requires, which the same command already calls
 * to resolve slug → appBlockId. Mirrors app-listings.router.cli-scope.test.ts.
 *
 * Bitmasks are hard-coded so an enum drift trips the sanity test rather than
 * silently re-pointing the gate.
 *
 * 🔴 WHICH OF THESE IS ACTUAL REGRESSION COVERAGE — measured, not assumed. With the
 * `.meta` line deleted, ONLY 'CLI OAuth login token … reaches the service' goes red,
 * and it fails with this gate's own error ("Your API key does not have the required
 * scope for this action", thrown by runEnforceTokenScope) — the exact 403 this change
 * fixes.
 *
 * EVERY other test in this describe block stays GREEN on pre-change code — currently
 * the three behavioural cases below, the enum-only bitmask sanity test, and the
 * schema-cap test at the end. Count them at the source rather than trusting a number
 * written here; a previous revision of this comment said "four" and was made stale by
 * a later round appending a fifth. Exactly ONE test in this block is regression
 * coverage. The rest are INVARIANT guards:
 *   - NO_SUBMIT was already FORBIDDEN before, because an un-annotated proc implicitly
 *     requires `Full` and that token lacks Full too. It pins that narrowing the gate
 *     did not accidentally WIDEN it — a different property, worth keeping, but it
 *     would not have caught the original bug.
 *   - the Full-key and session cases pin no-regression, and passed before by
 *     construction.
 * Do not read a block of green tests here as a block of tests OF THE FIX.
 */
const FULL = 33554431; // TokenScope.Full — a Full personal API key
const CLI = 1 | (1 << 25) | (1 << 26); // UserRead|AppBlocksSubmit|AppBlocksDevTunnel = 100663297
const NO_SUBMIT = 1 | (1 << 26); // UserRead|AppBlocksDevTunnel = 67108865 — lacks AppBlocksSubmit

// A token-authenticated caller (apiKeyId set) carrying `scope`. The user stays a
// moderator so the author/flag gates are satisfied and the ONLY variable is scope.
function tokenCtx(scope: number) {
  return { ...fakeCtx(modUser), apiKeyId: 999, tokenScope: scope };
}

describe('getMyAppAnalytics — OAuth scope gate', () => {
  it('the hard-coded bitmasks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(1 << 25);
    expect(TokenScope.UserRead | TokenScope.AppBlocksSubmit | TokenScope.AppBlocksDevTunnel).toBe(
      CLI
    );
    expect(TokenScope.UserRead | TokenScope.AppBlocksDevTunnel).toBe(NO_SUBMIT);
    // Full deliberately EXCLUDES AppBlocksSubmit — so it is enforceTokenScope's
    // early-return on Full, NOT hasFlag(Full, AppBlocksSubmit), that preserves the
    // existing personal-API-key path. If someone ever folds bit 25 into Full, this
    // fails and the reasoning above has to be revisited.
    expect((TokenScope.Full & TokenScope.AppBlocksSubmit) === TokenScope.AppBlocksSubmit).toBe(
      false
    );
  });

  it('CLI OAuth login token (carries AppBlocksSubmit) reaches the service', async () => {
    const caller = blocksRouter.createCaller(tokenCtx(CLI) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).resolves.toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
  });

  it('Full personal API key still reaches the service (no regression)', async () => {
    const caller = blocksRouter.createCaller(tokenCtx(FULL) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).resolves.toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
  });

  it('a scoped token WITHOUT AppBlocksSubmit is FORBIDDEN and never reaches the service', async () => {
    const caller = blocksRouter.createCaller(tokenCtx(NO_SUBMIT) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('scope'),
    });
    // The denial must come from the SCOPE gate, before any aggregate runs — not from
    // the author/flag gate, which this ctx satisfies.
    expect(mockGetMyAppAnalytics).not.toHaveBeenCalled();
  });

  it('a session (no bearer token) is unaffected — the web panel path', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getMyAppAnalytics({ appBlockId: 'apb_1' })).resolves.toBe(SENTINEL);
    expect(mockGetMyAppAnalytics).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 The no-regression property is CONDITIONAL, and this is what it rests on.
   *
   * enforceTokenScope's bypass is exact equality (`ctx.tokenScope !== TokenScope.Full`),
   * NOT `hasFlag`. So a mask that is a strict SUPERSET of Full but lacks bit 25 —
   * `Full|AppBlocksDevTunnel` = 100663295 — satisfied the un-annotated gate before and
   * is FORBIDDEN after. A real allow→deny flip.
   *
   * 🔴 SCOPE OF THIS TEST — it does NOT prove the flip is globally unreachable, and an
   * earlier revision of this comment wrongly implied it did. It pins the two PUBLIC
   * (zod-validated) surfaces only:
   *   - a personal API key's `tokenScope`, and
   *   - an OAuth client's `allowedScopes` via tRPC create/update.
   * It does NOT cover the non-zod writers, of which there are at least three — treat this
   * list as "the ones known when this was written", not a partition:
   *   - OAuth ACCESS tokens: the hub bounds a requested scope against `ALL_SCOPES`, not
   *     Full (deliberately, so an opt-in bit is not dropped), so a token's real ceiling is
   *     its client's `allowedScopes | UserRead`.
   *   - `allowedScopes` written by RAW SQL MIGRATION — exactly how the one client
   *     exceeding Full got its value (civitai-cli, now 100777985 after the AI-services
   *     widening for issue #3681, which is still NOT a superset of Full: bits 0/14/15/16/
   *     25/26 and none of 1..13 or 17..24, which is why the flip is unreachable in practice).
   *   - `allowedScopes` written by publish-request.service for `appblk-*` clients. Safe
   *     by construction (mapped bits are all below 25, and `grants: []` means no bearer
   *     token) rather than by any cap this test can assert on.
   *
   * So: if either cap below is raised, this test goes red. The MIGRATION case is no longer
   * held by inspection — `src/server/services/oauth/__tests__/oauth-client-scope-grants.test.ts`
   * enumerates every migration writing `"OauthClient"."allowedScopes"` and fails if the
   * folded grant for any client is a strict superset of Full. Neither test covers a grant
   * written outside a migration (a hand-run UPDATE), which remains inspection-only.
   */
  it('the two zod-validated credential surfaces reject a superset-of-Full mask', async () => {
    const { addApiKeyInputSchema } = await import('~/server/schema/api-key.schema');
    const { createOauthClientSchema, updateOauthClientSchema } = await import(
      '~/server/schema/oauth-client.schema'
    );

    const SUPERSET = TokenScope.Full | TokenScope.AppBlocksDevTunnel;
    expect(SUPERSET).toBe(100663295);
    // Sanity: this really is the allow→deny case — it satisfies Full by hasFlag (so it
    // passed the un-annotated gate) yet does not carry bit 25.
    expect((SUPERSET & TokenScope.Full) === TokenScope.Full).toBe(true);
    expect((SUPERSET & TokenScope.AppBlocksSubmit) === TokenScope.AppBlocksSubmit).toBe(false);

    // A personal API key cannot be created with it...
    expect(addApiKeyInputSchema.safeParse({ name: 'k', tokenScope: SUPERSET }).success).toBe(false);
    // ...nor an OAuth client be granted it, on create or update.
    const clientBase = {
      name: 'c',
      redirectUris: ['https://example.com/cb'],
    };
    expect(
      createOauthClientSchema.safeParse({ ...clientBase, allowedScopes: SUPERSET }).success
    ).toBe(false);
    expect(updateOauthClientSchema.safeParse({ id: 'c', allowedScopes: SUPERSET }).success).toBe(
      false
    );
    // Boundary controls: each cap must still ADMIT Full, or the rejections above prove
    // nothing (a fixture missing a required field would reject regardless of the scope,
    // and the test would still pass with the cap removed). One per assertion above —
    // the fixtures differ ONLY in the scope field, so a green here isolates the cap as
    // the cause.
    expect(addApiKeyInputSchema.safeParse({ name: 'k', tokenScope: TokenScope.Full }).success).toBe(
      true
    );
    expect(
      createOauthClientSchema.safeParse({ ...clientBase, allowedScopes: TokenScope.Full }).success
    ).toBe(true);
    expect(
      updateOauthClientSchema.safeParse({ id: 'c', allowedScopes: TokenScope.Full }).success
    ).toBe(true);
  });
});
