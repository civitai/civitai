import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * W13 P3b — off-site REPORT router AUTHZ + error-mapping + rate-limit wiring.
 *
 * Drives the REAL `appListingsRouter` via `createCaller` so the middleware wiring
 * (not a mock) decides:
 *   - reportListing is `protectedProcedure`: anon → UNAUTHORIZED; any signed-in
 *     user passes; the reporter id is forced from ctx (IDOR); a duplicate report
 *     (service ALREADY_REPORTED) maps to CONFLICT; a not-reportable listing maps to
 *     BAD_REQUEST; an unexpected infra error maps to INTERNAL (no raw leak).
 *   - listListingReports is `moderatorProcedure`: a non-mod is FORBIDDEN, a mod
 *     passes.
 *   - reportListing carries a rateLimit(20/3600) middleware (report-spam guard).
 */

const { mockReport, mockListReports, mockIsAppBlocksEnabled, mockIsAppBlocksAuthorEnabled, rateLimitCalls } =
  vi.hoisted(() => ({
    mockReport: vi.fn(async () => ({ reportId: 'alrp_1' })),
    mockListReports: vi.fn(async () => ({ items: [], nextCursor: null })),
    mockIsAppBlocksEnabled: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
    rateLimitCalls: [] as Array<{ limit?: number; period?: number }>,
  }));

vi.mock('~/server/services/blocks/offsite-moderation.service', () => ({
  reportListing: mockReport,
  listListingReports: mockListReports,
}));
// The router also statically references the P3a service names via dynamic import
// paths only, but the flag helpers are imported at module load — mock them.
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/services/feature-flags.service', async () => {
  const actual = await vi.importActual<typeof import('~/server/services/feature-flags.service')>(
    '~/server/services/feature-flags.service'
  );
  return {
    ...actual,
    getFeatureFlags: (ctx: { user?: { id?: number; isModerator?: boolean } }) => ({
      appBlocksAuthor: !!ctx.user?.isModerator,
    }),
  };
});
// Record the rateLimit config so the test can assert the report-spam guard is
// WIRED (the middleware itself is a passthrough here).
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: (opts: { limit?: number; period?: number }) => {
      rateLimitCalls.push(opts);
      return middleware(async ({ next }) => next());
    },
  };
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
const user = { id: 7, isModerator: false, tier: 'free', username: 'user', onboarding: 0x1f };

const reportInput = { appListingId: 'apl_target', reason: 'spam' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockImplementation((opts?: { user?: { isModerator?: boolean } }) =>
    Promise.resolve(!!opts?.user?.isModerator)
  );
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
});

describe('reportListing — protectedProcedure', () => {
  it('anonymous → rejects, service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.reportListing(reportInput)).rejects.toBeInstanceOf(TRPCError);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('any signed-in user passes; service called with the caller id (no user-supplied reporter)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    await caller.reportListing(reportInput);
    expect(mockReport).toHaveBeenCalledTimes(1);
    // The tRPC input middleware injects a `browsingLevel` — assert the id + the
    // report fields, and that the reporter is bound to the caller (ctx), not input.
    const call = mockReport.mock.calls[0][0] as {
      userId: number;
      input: { appListingId: string; reason: string };
    };
    expect(call.userId).toBe(user.id);
    expect(call.input.appListingId).toBe('apl_target');
    expect(call.input.reason).toBe('spam');
  });

  it('a mod passes too (any signed-in user)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.reportListing(reportInput);
    const call = mockReport.mock.calls[0][0] as {
      userId: number;
      input: { appListingId: string; reason: string };
    };
    expect(call.userId).toBe(mod.id);
    expect(call.input.appListingId).toBe('apl_target');
    expect(call.input.reason).toBe('spam');
  });

  it('a duplicate report (ALREADY_REPORTED) maps to CONFLICT with the friendly message', async () => {
    mockReport.mockRejectedValueOnce(
      offsiteModErr('ALREADY_REPORTED', 'You have already reported this app — a moderator is reviewing it.')
    );
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    await expect(caller.reportListing(reportInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('already reported'),
    });
  });

  // Info-leak guard: the service now raises the SAME generic NOT_REPORTABLE for a
  // missing AND a non-approved listing, so a caller can neither probe existence nor
  // read the moderation status. Both map to BAD_REQUEST with the generic message.
  it('a not-reportable listing (missing OR non-approved) maps to BAD_REQUEST with a generic message', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);

    mockReport.mockRejectedValueOnce(
      offsiteModErr('NOT_REPORTABLE', 'This app can no longer be reported.')
    );
    await expect(caller.reportListing(reportInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This app can no longer be reported.',
    });
  });

  it('the not-reportable client message never leaks the exact status or existence', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    // Even though the service knows the real reason, the client-facing message is
    // generic — no 'draft'/'not found'/status token reaches the caller.
    mockReport.mockRejectedValueOnce(
      offsiteModErr('NOT_REPORTABLE', 'This app can no longer be reported.')
    );
    const err = await caller.reportListing(reportInput).then(
      () => {
        throw new Error('expected reportListing to reject');
      },
      (e) => e as TRPCError
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).not.toContain('draft');
    expect(err.message).not.toContain('not found');
    expect(err.message).not.toContain('status');
  });

  it('an UNEXPECTED/untyped error maps to INTERNAL_SERVER_ERROR without leaking the raw message', async () => {
    const raw = 'connect ECONNREFUSED 10.0.0.5:5432 postgres://secret-dsn';
    mockReport.mockRejectedValueOnce(new Error(raw));
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    const err = await caller.reportListing(reportInput).then(
      () => {
        throw new Error('expected reportListing to reject');
      },
      (e) => e as TRPCError
    );
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('secret-dsn');
    expect((err.cause as Error | undefined)?.message).toBe(raw);
  });

  it('rejects an invalid reason at the SCHEMA boundary (service NOT called)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    await expect(
      caller.reportListing({ appListingId: 'apl_target', reason: 'bogus' } as never)
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockReport).not.toHaveBeenCalled();
  });
});

describe('reportListing — rate-limit wiring', () => {
  it('is guarded by rateLimit(20/3600) (report-spam guard)', () => {
    expect(rateLimitCalls).toContainEqual(expect.objectContaining({ limit: 20, period: 3600 }));
  });
});

describe('listListingReports — moderatorProcedure', () => {
  it('a plain user is FORBIDDEN; service NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    await expect(caller.listListingReports({})).rejects.toBeInstanceOf(TRPCError);
    expect(mockListReports).not.toHaveBeenCalled();
  });

  it('anonymous is rejected', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listListingReports({})).rejects.toBeInstanceOf(TRPCError);
  });

  it('a moderator passes', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.listListingReports({ status: 'pending' })).resolves.toBeDefined();
    expect(mockListReports).toHaveBeenCalledWith({ status: 'pending' });
  });
});
