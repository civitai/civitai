import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 P3b PR3 — off-site mod-ACTION router AUTHZ matrix + error mapping.
 *
 * Drives the REAL `appListingsRouter` via `createCaller` so the middleware wiring
 * decides: delist / relist / claim / purge / resolveReport / dismissReport /
 * listModerationEvents are ALL `moderatorProcedure` (+ the inner `isModerator`
 * recheck) → a tester (non-mod) is FORBIDDEN on every one, a mod passes with the
 * reviewer bound to `ctx.user.id`, and typed `OffsiteModerationError`s map through
 * `mapOffsiteError` (NOT_FOUND→NOT_FOUND, NOT_TRANSITIONABLE/INVALID_TARGET_USER→
 * BAD_REQUEST, unexpected infra→INTERNAL with no raw leak). `claimListing` (PR4) is
 * `moderatorProcedure` — there is deliberately NO `protectedProcedure` self-claim
 * endpoint (mod-only is the whole boundary), asserted by the caller-proc probe.
 */

const {
  mockDelist,
  mockRelist,
  mockClaim,
  mockPurge,
  mockResolve,
  mockDismiss,
  mockListEvents,
  mockReport,
  mockListReports,
  mockResetOnsite,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
} = vi.hoisted(() => ({
  mockDelist: vi.fn(async () => ({ appListingId: 'apl_1', status: 'removed' as const })),
  mockRelist: vi.fn(async () => ({ appListingId: 'apl_1', status: 'approved' as const })),
  mockResetOnsite: vi.fn(async () => ({
    appListingId: 'apl_1',
    status: 'pending' as const,
    publishRequestId: 'pubreq_1',
  })),
  mockClaim: vi.fn(async () => ({ appListingId: 'apl_1', userId: 42 })),
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
  claimListing: mockClaim,
  purgeListing: mockPurge,
  resolveReport: mockResolve,
  dismissReport: mockDismiss,
  listModerationEvents: mockListEvents,
  resetOnsiteListingToPending: mockResetOnsite,
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
    name: 'claimListing',
    mock: mockClaim,
    call: (c) => c.claimListing({ appListingId: 'apl_1', targetUserId: 42, reason: REASON }),
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
  {
    // W13 onsite reset-to-pending — DARK backend capability, mod-only router acceptance.
    name: 'resetOnsiteListingToPending',
    mock: mockResetOnsite,
    call: (c) => c.resetOnsiteListingToPending({ appListingId: 'apl_1', reason: REASON }),
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
  it('delist/relist/claim/purge pass reviewerUserId = ctx.user.id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.delistListing({ appListingId: 'apl_1', reason: REASON });
    await caller.relistListing({ appListingId: 'apl_1', reason: REASON });
    await caller.claimListing({ appListingId: 'apl_1', targetUserId: 42, reason: REASON });
    await caller.purgeListing({ appListingId: 'apl_1', reason: REASON });
    expect(mockDelist.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
    expect(mockRelist.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
    // claim forwards the whole input (targetUserId) + the ctx-bound reviewer.
    expect(mockClaim.mock.calls[0][0]).toMatchObject({
      reviewerUserId: mod.id,
      input: { appListingId: 'apl_1', targetUserId: 42, reason: REASON },
    });
    expect(mockPurge.mock.calls[0][0]).toMatchObject({ reviewerUserId: mod.id });
  });

  it('resetOnsiteListingToPending passes reviewerUserId = ctx.user.id + the input', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.resetOnsiteListingToPending({ appListingId: 'apl_1', reason: REASON });
    expect(mockResetOnsite.mock.calls[0][0]).toMatchObject({
      reviewerUserId: mod.id,
      input: { appListingId: 'apl_1', reason: REASON },
    });
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

  it('a typed INVALID_TARGET_USER (claim) maps to BAD_REQUEST with the friendly message', async () => {
    mockClaim.mockRejectedValueOnce(
      offsiteModErr('INVALID_TARGET_USER', 'The target user could not be found.')
    );
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.claimListing({ appListingId: 'apl_1', targetUserId: 999999, reason: REASON })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('target user'),
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

  it('rejects a too-short claim reason + a non-positive targetUserId at the SCHEMA boundary', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.claimListing({ appListingId: 'apl_1', targetUserId: 42, reason: 'x' })
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.claimListing({ appListingId: 'apl_1', targetUserId: 0, reason: REASON })
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.claimListing({ appListingId: 'apl_1', targetUserId: -5, reason: REASON })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe('claimListing (PR4) is exposed as moderator-only — NO self-service endpoint', () => {
  it('the router exposes claimListing alongside the other mod actions', () => {
    // The tRPC caller proxy fabricates a function for ANY path, so probe the router
    // DEFINITION's procedure record (the source of truth) instead of the caller.
    const procs = Object.keys(
      (appListingsRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures
    );
    for (const p of [
      'delistListing',
      'relistListing',
      'claimListing',
      'purgeListing',
      'resolveReport',
      'dismissReport',
      'listModerationEvents',
    ]) {
      expect(procs).toContain(p);
    }
  });

  it('there is EXACTLY ONE claim endpoint (no separate protectedProcedure self-claim)', () => {
    // The mod-only gate is the whole boundary: a user cannot claim their own listing.
    // Assert by absence — no `claimMyListing`/`requestClaim`/`selfClaim`-style proc.
    const procs = Object.keys(
      (appListingsRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures
    );
    const claimProcs = procs.filter((p) => /claim/i.test(p));
    expect(claimProcs).toEqual(['claimListing']);
  });
});
