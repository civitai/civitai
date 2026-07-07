import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 P3b PR3 — off-site mod-ACTION router AUTHZ matrix + error mapping.
 *
 * Drives the REAL `appListingsRouter` via `createCaller` so the middleware wiring
 * decides: delist / relist / purge / resolveReport / dismissReport /
 * listModerationEvents are ALL `moderatorProcedure` (+ the inner `isModerator`
 * recheck) → a tester (non-mod) is FORBIDDEN on every one, a mod passes with the
 * reviewer bound to `ctx.user.id`, and typed `OffsiteModerationError`s map through
 * `mapOffsiteError` (NOT_FOUND→NOT_FOUND, NOT_TRANSITIONABLE→BAD_REQUEST,
 * unexpected infra→INTERNAL with no raw leak). The `claimListing` proc does NOT
 * exist yet (PR4) — asserted by absence.
 */

const {
  mockDelist,
  mockRelist,
  mockPurge,
  mockResolve,
  mockDismiss,
  mockListEvents,
  mockReport,
  mockListReports,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
} = vi.hoisted(() => ({
  mockDelist: vi.fn(async () => ({ appListingId: 'apl_1', status: 'removed' as const })),
  mockRelist: vi.fn(async () => ({ appListingId: 'apl_1', status: 'approved' as const })),
  mockPurge: vi.fn(async () => ({ appListingId: 'apl_1', purged: true as const })),
  mockResolve: vi.fn(async () => undefined),
  mockDismiss: vi.fn(async () => undefined),
  mockListEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
  mockReport: vi.fn(async () => ({ reportId: 'alrp_1' })),
  mockListReports: vi.fn(async () => ({ items: [], nextCursor: null })),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksAuthorEnabled: vi.fn(),
}));

vi.mock('~/server/services/blocks/offsite-moderation.service', () => ({
  reportListing: mockReport,
  listListingReports: mockListReports,
  delistListing: mockDelist,
  relistListing: mockRelist,
  purgeListing: mockPurge,
  resolveReport: mockResolve,
  dismissReport: mockDismiss,
  listModerationEvents: mockListEvents,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function offsiteModErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'OffsiteModerationError', code });
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
    features: {} as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const tester = { id: 2, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };

const REASON = 'confirmed impersonation of a real vendor';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockImplementation((opts?: { user?: { isModerator?: boolean } }) =>
    Promise.resolve(!!opts?.user?.isModerator)
  );
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
});

// Every mod action, keyed by a caller that invokes it with a VALID input so the
// schema passes and the authz/middleware is what decides.
const MOD_ACTIONS: Array<{
  name: string;
  mock: ReturnType<typeof vi.fn>;
  call: (c: ReturnType<typeof appListingsRouter.createCaller>) => Promise<unknown>;
}> = [
  {
    name: 'delistListing',
    mock: mockDelist,
    call: (c) => c.delistListing({ appListingId: 'apl_1', reason: REASON }),
  },
  {
    name: 'relistListing',
    mock: mockRelist,
    call: (c) => c.relistListing({ appListingId: 'apl_1', reason: REASON }),
  },
  {
    name: 'purgeListing',
    mock: mockPurge,
    call: (c) => c.purgeListing({ appListingId: 'apl_1', reason: REASON }),
  },
  {
    name: 'resolveReport',
    mock: mockResolve,
    call: (c) => c.resolveReport({ reportId: 'alrp_1', note: 'ok' }),
  },
  {
    name: 'dismissReport',
    mock: mockDismiss,
    call: (c) => c.dismissReport({ reportId: 'alrp_1' }),
  },
  {
    name: 'listModerationEvents',
    mock: mockListEvents,
    call: (c) => c.listModerationEvents({ appListingId: 'apl_1' }),
  },
];

describe('mod actions — every one is moderator-only', () => {
  for (const action of MOD_ACTIONS) {
    it(`${action.name}: a tester is FORBIDDEN; service NOT called`, async () => {
      const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
      await expect(action.call(caller)).rejects.toBeInstanceOf(TRPCError);
      expect(action.mock).not.toHaveBeenCalled();
    });

    it(`${action.name}: anonymous is rejected; service NOT called`, async () => {
      const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
      await expect(action.call(caller)).rejects.toBeInstanceOf(TRPCError);
      expect(action.mock).not.toHaveBeenCalled();
    });

    it(`${action.name}: a moderator passes`, async () => {
      const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
      await expect(action.call(caller)).resolves.toBeDefined();
      expect(action.mock).toHaveBeenCalledTimes(1);
    });
  }
});

describe('mod actions — reviewer id is bound to ctx (never client-supplied)', () => {
  it('delist/relist/purge pass reviewerUserId = ctx.user.id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.delistListing({ appListingId: 'apl_1', reason: REASON });
    await caller.relistListing({ appListingId: 'apl_1', reason: REASON });
    await caller.purgeListing({ appListingId: 'apl_1', reason: REASON });
    expect(mockDelist.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
    expect(mockRelist.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
    expect(mockPurge.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
  });

  it('resolve/dismiss pass reviewerUserId = ctx.user.id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.resolveReport({ reportId: 'alrp_1' });
    await caller.dismissReport({ reportId: 'alrp_1' });
    expect(mockResolve.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
    expect(mockDismiss.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
  });
});

describe('mod actions — error mapping via mapOffsiteError', () => {
  it('a typed NOT_TRANSITIONABLE maps to BAD_REQUEST', async () => {
    mockDelist.mockRejectedValueOnce(offsiteModErr('NOT_TRANSITIONABLE', 'This listing can no longer be delisted.'));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.delistListing({ appListingId: 'apl_1', reason: REASON })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('no longer be delisted'),
    });
  });

  it('a typed NOT_FOUND maps to NOT_FOUND', async () => {
    mockRelist.mockRejectedValueOnce(offsiteModErr('NOT_FOUND', 'Off-site listing not found.'));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.relistListing({ appListingId: 'apl_x', reason: REASON })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a typed REPORT_NOT_PENDING maps to BAD_REQUEST', async () => {
    mockResolve.mockRejectedValueOnce(offsiteModErr('REPORT_NOT_PENDING', 'This report has already been handled.'));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.resolveReport({ reportId: 'alrp_1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('an unexpected infra error maps to INTERNAL without leaking the raw message', async () => {
    const raw = 'connect ECONNREFUSED 10.0.0.5:5432 postgres://secret-dsn';
    mockPurge.mockRejectedValueOnce(new Error(raw));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    const err = await caller.purgeListing({ appListingId: 'apl_1', reason: REASON }).then(
      () => {
        throw new Error('expected purge to reject');
      },
      (e) => e as TRPCError
    );
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('secret-dsn');
  });

  it('rejects a too-short delist reason at the SCHEMA boundary (service NOT called)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.delistListing({ appListingId: 'apl_1', reason: 'x' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockDelist).not.toHaveBeenCalled();
  });
});

describe('claimListing is NOT exposed in PR3 (it is PR4)', () => {
  it('the router exposes the 5 PR3 mod actions but NOT claimListing', () => {
    // The tRPC caller proxy fabricates a function for ANY path, so probe the router
    // DEFINITION's procedure record (the source of truth) instead of the caller.
    const procs = Object.keys(
      (appListingsRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures
    );
    for (const p of [
      'delistListing',
      'relistListing',
      'purgeListing',
      'resolveReport',
      'dismissReport',
      'listModerationEvents',
    ]) {
      expect(procs).toContain(p);
    }
    expect(procs).not.toContain('claimListing');
  });
});
