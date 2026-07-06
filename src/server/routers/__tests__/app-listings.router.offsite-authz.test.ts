import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 P3a — off-site submission router AUTHZ matrix.
 *
 * Drives the REAL `appListingsRouter` via `createCaller` so the middleware wiring
 * (not a mock) decides:
 *   - submit / withdraw / listMySubmissions are `appDeveloperProcedure`
 *     (`app-blocks-author`): a non-author is FORBIDDEN; a mod (author floor) and
 *     an app-dev-tester (cohort) pass.
 *   - listPending/Approved/Rejected are `moderatorProcedure`: a non-mod author is
 *     FORBIDDEN (an author can submit but NOT review).
 *   - the widened asset-CRUD flag gate (`enforceAppBlocksAuthorFlag`) lets a
 *     tester manage their OWN listing's assets but the service owner check still
 *     bounds them to their own listings (a foreign listing → FORBIDDEN).
 *
 * `appDeveloperProcedure` reads `getFeatureFlags(ctx).appBlocksAuthor`, so we
 * mock that with a faithful per-user impl (mod OR the tester cohort → true). The
 * `app-blocks-author` flag helper (`isAppBlocksAuthorEnabled`) is mocked with the
 * SAME rule for the asset-CRUD gate. The services are mocked so importing the
 * router never drags in the generated Prisma client.
 */

const AUTHOR_IDS = new Set([2]); // the app-dev-tester cohort (non-mod authors)

const {
  mockSubmit,
  mockWithdraw,
  mockListMy,
  mockListPending,
  mockListApproved,
  mockListRejected,
  mockApprove,
  mockReject,
  mockSetIcon,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
} = vi.hoisted(() => ({
  mockSubmit: vi.fn(async () => ({ listingId: 'apl_1', publishRequestId: 'alpr_1', slug: 's' })),
  mockWithdraw: vi.fn(async () => undefined),
  mockListMy: vi.fn(async () => ({ items: [], nextCursor: null })),
  mockListPending: vi.fn(async () => ({ items: [{ id: 'alpr_1' }], nextCursor: null })),
  mockListApproved: vi.fn(async () => ({ items: [], nextCursor: null })),
  mockListRejected: vi.fn(async () => ({ items: [], nextCursor: null })),
  mockApprove: vi.fn(async () => ({ publishRequestId: 'alpr_1', listingId: 'apl_1', slug: 's' })),
  mockReject: vi.fn(async () => undefined),
  // Faithful owner-check stand-in: throw FORBIDDEN when the caller doesn't own
  // the target listing (listingId encodes the owner: `own-<id>` / `other-<id>`).
  mockSetIcon: vi.fn(async (input: { listingId: string }, user: { id: number }) => {
    const ownerId = Number(input.listingId.split('-')[1]);
    if (ownerId !== user.id) throw new TRPCError({ code: 'FORBIDDEN', message: 'not owner' });
    return { iconId: 5 };
  }),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksAuthorEnabled: vi.fn(),
}));

vi.mock('~/server/services/blocks/offsite-listing.service', () => ({
  submitExternalListing: mockSubmit,
  withdrawExternalRequest: mockWithdraw,
  listMySubmissions: mockListMy,
  listPendingOffsiteRequests: mockListPending,
  listApprovedOffsiteRequests: mockListApproved,
  listRejectedOffsiteRequests: mockListRejected,
  approveExternalRequest: mockApprove,
  rejectExternalRequest: mockReject,
}));
vi.mock('~/server/services/blocks/app-listing-assets.service', () => ({
  setListingIcon: mockSetIcon,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
// appDeveloperProcedure gates on getFeatureFlags(ctx).appBlocksAuthor — mock it
// with the SAME faithful rule (mod floor OR the tester cohort).
vi.mock('~/server/services/feature-flags.service', async () => {
  const actual = await vi.importActual<typeof import('~/server/services/feature-flags.service')>(
    '~/server/services/feature-flags.service'
  );
  return {
    ...actual,
    getFeatureFlags: (ctx: { user?: { id?: number; isModerator?: boolean } }) => ({
      appBlocksAuthor:
        !!ctx.user && (!!ctx.user.isModerator || AUTHOR_IDS.has(ctx.user.id ?? -1)),
    }),
  };
});
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Faithful per-user author gate: ON iff the caller is a mod OR in the tester cohort. */
function fakeAuthorFlag(opts?: { user?: { id?: number; isModerator?: boolean } }) {
  const u = opts?.user;
  return Promise.resolve(!!u && (!!u.isModerator || AUTHOR_IDS.has(u.id ?? -1)));
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

/**
 * Fabricate a typed `OffsiteRequestError`-shaped throwable WITHOUT importing the
 * (mocked) service module. The router duck-types on `name === 'OffsiteRequestError'`
 * + a string `code`, so this exercises the real mapping path.
 */
function offsiteErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'OffsiteRequestError', code });
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const tester = { id: 2, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };
const nonAuthor = { id: 3, isModerator: false, tier: 'free', username: 'user', onboarding: 0x1f };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockImplementation((opts?: { user?: { isModerator?: boolean } }) =>
    Promise.resolve(!!opts?.user?.isModerator)
  );
  mockIsAppBlocksAuthorEnabled.mockImplementation(fakeAuthorFlag);
});

// ---------------------------------------------------------------------------
// AUTHOR procs (appDeveloperProcedure).
// ---------------------------------------------------------------------------

const submitInput = { slug: 'cool-app', name: 'Cool', externalUrl: 'https://x.example.com' };

describe('submitExternalListing — appDeveloperProcedure (app-blocks-author)', () => {
  it('non-author (non-mod, no cohort) → FORBIDDEN, service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(nonAuthor) as never);
    await expect(caller.submitExternalListing(submitInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('anonymous → UNAUTHORIZED/FORBIDDEN, service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.submitExternalListing(submitInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('moderator (author floor) → passes; service called with the caller id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.submitExternalListing(submitInput);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ userId: mod.id });
  });

  it('app-dev-tester (cohort) → passes; service called with the tester id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    await caller.submitExternalListing(submitInput);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ userId: tester.id });
  });
});

describe('withdrawExternalRequest — appDeveloperProcedure', () => {
  it('non-author → FORBIDDEN', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(nonAuthor) as never);
    await expect(
      caller.withdrawExternalRequest({ publishRequestId: 'alpr_1' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('tester → passes; withdraw called with the caller id (IDOR bound in the service)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    await caller.withdrawExternalRequest({ publishRequestId: 'alpr_1' });
    expect(mockWithdraw).toHaveBeenCalledWith({ publishRequestId: 'alpr_1', userId: tester.id });
  });

  it('a service failure maps to BAD_REQUEST with the message', async () => {
    mockWithdraw.mockRejectedValueOnce(new Error('you can only withdraw your own publish requests'));
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    await expect(
      caller.withdrawExternalRequest({ publishRequestId: 'alpr_x' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('your own') });
  });
});

describe('listMySubmissions — appDeveloperProcedure', () => {
  it('non-author → FORBIDDEN', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(nonAuthor) as never);
    await expect(caller.listMySubmissions({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockListMy).not.toHaveBeenCalled();
  });

  it('tester → passes; scoped to the caller id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    await caller.listMySubmissions({});
    expect(mockListMy).toHaveBeenCalledWith(expect.objectContaining({ userId: tester.id }));
  });
});

// ---------------------------------------------------------------------------
// MOD queue lists (moderatorProcedure).
// ---------------------------------------------------------------------------

describe('review-queue lists — moderatorProcedure', () => {
  for (const proc of ['listPendingRequests', 'listApprovedRequests', 'listRejectedRequests'] as const) {
    it(`${proc}: a non-mod AUTHOR (tester) is FORBIDDEN`, async () => {
      const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
      await expect(caller[proc]({})).rejects.toBeInstanceOf(TRPCError);
    });

    it(`${proc}: a plain user is FORBIDDEN`, async () => {
      const caller = appListingsRouter.createCaller(fakeCtx(nonAuthor) as never);
      await expect(caller[proc]({})).rejects.toBeInstanceOf(TRPCError);
    });

    it(`${proc}: a moderator passes`, async () => {
      const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
      await expect(caller[proc]({})).resolves.toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// MOD approve / reject (moderatorProcedure) — PR-b.
// ---------------------------------------------------------------------------

const approveInput = { publishRequestId: 'alpr_1', approvalNotes: 'ok' };
const rejectInput = { publishRequestId: 'alpr_1', rejectionReason: 'spam listing, not a real app' };

describe('approveExternalRequest — moderatorProcedure', () => {
  it('a non-mod AUTHOR (tester) is FORBIDDEN; service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    await expect(caller.approveExternalRequest(approveInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('a plain user is FORBIDDEN', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(nonAuthor) as never);
    await expect(caller.approveExternalRequest(approveInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('a moderator passes; service called with the reviewer id', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.approveExternalRequest(approveInput);
    expect(mockApprove).toHaveBeenCalledWith({
      publishRequestId: 'alpr_1',
      reviewerUserId: mod.id,
      approvalNotes: 'ok',
    });
  });

  it('a typed BAD_REQUEST service failure (e.g. missing assets) passes THROUGH as BAD_REQUEST with the message', async () => {
    // The real assets-incomplete failure is a TRPCError(BAD_REQUEST) from the
    // service — it passes through unchanged so the mod sees the useful message.
    mockApprove.mockRejectedValueOnce(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Listing is missing required assets: screenshots',
      })
    );
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.approveExternalRequest(approveInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('missing required assets'),
    });
  });

  it('a typed OffsiteRequestError(NOT_FOUND) maps to TRPC NOT_FOUND (not BAD_REQUEST)', async () => {
    mockApprove.mockRejectedValueOnce(offsiteErr('NOT_FOUND', 'publish request alpr_1 not found'));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.approveExternalRequest(approveInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('not found'),
    });
  });

  it('a typed OffsiteRequestError(NOT_PENDING) maps to TRPC BAD_REQUEST', async () => {
    mockApprove.mockRejectedValueOnce(
      offsiteErr('NOT_PENDING', 'cannot approve — the request is no longer pending')
    );
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.approveExternalRequest(approveInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('no longer pending'),
    });
  });

  it('an UNEXPECTED/untyped service error maps to INTERNAL_SERVER_ERROR and does NOT leak the raw message', async () => {
    const raw = 'connect ECONNREFUSED 10.0.0.5:5432 postgres://secret-dsn';
    mockApprove.mockRejectedValueOnce(new Error(raw));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    const err = await caller.approveExternalRequest(approveInput).then(
      () => {
        throw new Error('expected approve to reject');
      },
      (e) => e as TRPCError
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    // The raw infra message must NOT reach the mod client (generic message only);
    // the original is preserved on `cause` for server-side logging.
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('secret-dsn');
    expect((err.cause as Error | undefined)?.message).toBe(raw);
  });
});

describe('rejectExternalRequest — moderatorProcedure', () => {
  it('a non-mod AUTHOR (tester) is FORBIDDEN; service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    await expect(caller.rejectExternalRequest(rejectInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockReject).not.toHaveBeenCalled();
  });

  it('a moderator passes; service called with the reviewer id + reason', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.rejectExternalRequest(rejectInput);
    expect(mockReject).toHaveBeenCalledWith({
      publishRequestId: 'alpr_1',
      reviewerUserId: mod.id,
      rejectionReason: rejectInput.rejectionReason,
    });
  });

  it('a short reason is rejected at the SCHEMA boundary (min 10)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.rejectExternalRequest({ publishRequestId: 'alpr_1', rejectionReason: 'short' })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockReject).not.toHaveBeenCalled();
  });

  it('a typed OffsiteRequestError(NOT_FOUND) maps to TRPC NOT_FOUND', async () => {
    mockReject.mockRejectedValueOnce(offsiteErr('NOT_FOUND', 'publish request alpr_1 not found'));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.rejectExternalRequest(rejectInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an UNEXPECTED/untyped service error maps to INTERNAL_SERVER_ERROR without leaking the message', async () => {
    const raw = 'Prisma P1001: cannot reach database server at db:5432';
    mockReject.mockRejectedValueOnce(new Error(raw));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    const err = await caller.rejectExternalRequest(rejectInput).then(
      () => {
        throw new Error('expected reject to reject');
      },
      (e) => e as TRPCError
    );
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).not.toContain('P1001');
    expect((err.cause as Error | undefined)?.message).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Asset-CRUD flag widening (enforceAppBlocksAuthorFlag) + owner boundary.
// ---------------------------------------------------------------------------

describe('setIcon — widened author flag gate + service owner check', () => {
  it('non-author (author flag off) → UNAUTHORIZED, service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(nonAuthor) as never);
    await expect(
      caller.setIcon({ listingId: 'own-3', imageId: 5 })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockSetIcon).not.toHaveBeenCalled();
  });

  it('app-dev-tester CAN attach to their OWN listing', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    // listingId `own-2` is owned by the tester (id 2).
    await expect(caller.setIcon({ listingId: 'own-2', imageId: 5 })).resolves.toEqual({ iconId: 5 });
    expect(mockSetIcon).toHaveBeenCalledWith({ listingId: 'own-2', imageId: 5 }, tester);
  });

  it('app-dev-tester CANNOT attach to ANOTHER user’s listing (owner check → FORBIDDEN)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    // listingId `other-99` is owned by user 99, not the tester.
    await expect(
      caller.setIcon({ listingId: 'other-99', imageId: 5 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('moderator (author floor) can attach as well', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.setIcon({ listingId: 'own-1', imageId: 5 })).resolves.toEqual({ iconId: 5 });
  });
});
