import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
// Type-only imports (erased at runtime, so they are safe above the hoisted
// `vi.mock` calls) — the lint rule forbids inline `import()` type annotations.
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * `blocks.resyncListingRating` / `blocks.getListingRatingResyncPreview` — router AUTHZ, the
 * session-bound actor, and error mapping. Harness copied from
 * `blocks.router.retriggerBuild.test.ts`; the service's behaviour is pinned in
 * `publish-request.listingRatingSync.test.ts`.
 *
 * (The retrigger suite's notes follow, for the harness.)
 *
 * Drives the REAL `blocksRouter` through `createCaller` so the MIDDLEWARE WIRING
 * is what decides, not a hand-rolled stand-in. Three things are pinned:
 *
 *   1. MODERATOR-ONLY. It is a `moderatorProcedure` with the same redundant inner
 *      `ctx.user?.isModerator` belt `approveRequest` carries. A non-mod (and an
 *      anonymous caller) is rejected and the SERVICE IS NEVER REACHED.
 *   2. NO SHA ON THE WIRE. The zod input accepts ONLY `publishRequestId` — a
 *      caller cannot name a commit to build. This makes "rebuild an arbitrary,
 *      unreviewed sha" structurally impossible rather than merely guarded.
 *   3. TYPED ERROR MAPPING. NOT_FOUND -> NOT_FOUND, RATE_LIMITED ->
 *      TOO_MANY_REQUESTS, TRIGGER_FAILED -> INTERNAL_SERVER_ERROR (a build-service
 *      outage is a server fault, not a malformed request), everything else ->
 *      BAD_REQUEST.
 *
 * Heavy-mock skeleton copied from `blocks.router.listMyPublishRequests.test.ts` so
 * importing the router doesn't drag in the generated Prisma client.
 */

const { mockIsAppBlocksEnabled, mockResync, mockPreview } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockResync: vi.fn<(...a: any[]) => Promise<unknown>>(async () => ({
    listingId: 'apl_1',
    from: 'x',
    to: 'pg13',
    changed: true,
  })),
  mockPreview: vi.fn<(...a: any[]) => Promise<unknown>>(async () => ({
    listingId: 'apl_1',
    from: 'x',
    to: 'pg13',
  })),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true, appBlocksPages: false }),
}));
// The router dynamically imports the whole publish-request service; stub just the
// export under test plus the handful the module graph needs.
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  resyncListingRating: mockResync,
  previewListingRatingResync: mockPreview,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
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

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: true, appBlocksAuthor: true } as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const tester = { id: 2, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };
const APP = 'apb_1';

const serviceErr = (code: string, message: string) =>
  Object.assign(new Error(message), { name: 'ListingRatingResyncError', code });

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
});

describe('blocks.resyncListingRating — moderator gate', () => {
  it('a NON-MODERATOR is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(caller.resyncListingRating({ appBlockId: APP })).rejects.toBeInstanceOf(TRPCError);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it('an ANONYMOUS caller is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.resyncListingRating({ appBlockId: APP })).rejects.toBeInstanceOf(TRPCError);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it('a MODERATOR runs it, as the SESSION user — a client-supplied actor is dropped', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.resyncListingRating({ appBlockId: APP, actorUserId: 9999 } as never)
    ).resolves.toEqual({ listingId: 'apl_1', from: 'x', to: 'pg13', changed: true });
    expect(mockResync).toHaveBeenCalledWith({ appBlockId: APP, actorUserId: mod.id });
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['CONFLICT', 'CONFLICT'],
    ['SOMETHING_ELSE', 'INTERNAL_SERVER_ERROR'],
  ])('maps a service %s to %s', async (serviceCode, trpcCode) => {
    mockResync.mockRejectedValueOnce(serviceErr(serviceCode, 'nope'));
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.resyncListingRating({ appBlockId: APP })).rejects.toMatchObject({
      code: trpcCode,
    });
  });
});

describe('blocks.getListingRatingResyncPreview — moderator gate', () => {
  it('a NON-MODERATOR is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(caller.getListingRatingResyncPreview({ appBlockId: APP })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('a MODERATOR gets the preview', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.getListingRatingResyncPreview({ appBlockId: APP })).resolves.toEqual({
      listingId: 'apl_1',
      from: 'x',
      to: 'pg13',
    });
    expect(mockPreview).toHaveBeenCalledWith(APP);
  });
});
