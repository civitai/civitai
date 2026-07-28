import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
// Type-only imports (erased at runtime, so they are safe above the hoisted
// `vi.mock` calls) — the lint rule forbids inline `import()` type annotations.
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as RedisClient from '@civitai/redis/client';

/**
 * `blocks.retriggerBuild` — router AUTHZ + input surface + error mapping.
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

const { mockIsAppBlocksEnabled, mockRetrigger, mockDbRead } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockRetrigger: vi.fn<(...a: any[]) => Promise<unknown>>(async () => ({
    publishRequestId: 'pubreq_1',
    appBlockId: 'apb_x',
    forgejoCommitSha: 'a'.repeat(40),
  })),
  mockDbRead: {
    appBlockPublishRequest: { findMany: vi.fn(), findUnique: vi.fn() },
    appListing: { findMany: vi.fn() },
    appListingModerationEvent: { findMany: vi.fn() },
    blockUserSubscription: { groupBy: vi.fn() },
  },
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
  retriggerBuild: mockRetrigger,
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
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof RedisClient>('@civitai/redis/client');
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn() },
    sysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
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
const REQ_ID = 'pubreq_1';

function retriggerErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'RetriggerBuildError', code });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockRetrigger.mockResolvedValue({
    publishRequestId: REQ_ID,
    appBlockId: 'apb_x',
    forgejoCommitSha: 'a'.repeat(40),
  });
});

describe('blocks.retriggerBuild — moderator gate', () => {
  it('a NON-MODERATOR is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it('an ANONYMOUS caller is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it('a user who merely CLAIMS elevation in the payload is still rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(
      caller.retriggerBuild({ publishRequestId: REQ_ID, isModerator: true } as never)
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it('a MODERATOR passes and the service runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).resolves.toMatchObject({
      publishRequestId: REQ_ID,
    });
    expect(mockRetrigger).toHaveBeenCalledTimes(1);
  });

  it('binds the reviewer to the SESSION user id — never anything client-supplied', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await caller.retriggerBuild({
      publishRequestId: REQ_ID,
      reviewerUserId: 9999,
    } as never);
    expect(mockRetrigger).toHaveBeenCalledWith({
      publishRequestId: REQ_ID,
      reviewerUserId: mod.id,
    });
  });
});

describe('blocks.retriggerBuild — input surface: NO sha on the wire', () => {
  it('passes ONLY publishRequestId + the session reviewer to the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await caller.retriggerBuild({ publishRequestId: REQ_ID });
    // Exact-equality: any additional forwarded field would fail this.
    expect(mockRetrigger).toHaveBeenCalledWith({
      publishRequestId: REQ_ID,
      reviewerUserId: mod.id,
    });
  });

  it('a caller-supplied sha is STRIPPED by the schema and never reaches the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await caller.retriggerBuild({
      publishRequestId: REQ_ID,
      sha: 'b'.repeat(40),
      forgejoCommitSha: 'c'.repeat(40),
      ref: 'refs/heads/attacker',
    } as never);
    const args = mockRetrigger.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['publishRequestId', 'reviewerUserId']);
    expect(JSON.stringify(args)).not.toContain('b'.repeat(40));
    expect(JSON.stringify(args)).not.toContain('c'.repeat(40));
    expect(JSON.stringify(args)).not.toContain('refs/heads/attacker');
  });

  it('rejects a missing / empty / oversized publishRequestId at the schema', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({} as never)).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.retriggerBuild({ publishRequestId: '' })).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.retriggerBuild({ publishRequestId: 'x'.repeat(65) })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRetrigger).not.toHaveBeenCalled();
  });
});

describe('blocks.retriggerBuild — typed error mapping', () => {
  it('NOT_FOUND maps to a NOT_FOUND TRPCError', async () => {
    mockRetrigger.mockRejectedValue(retriggerErr('NOT_FOUND', 'publish request nope not found'));
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('RATE_LIMITED maps to TOO_MANY_REQUESTS', async () => {
    mockRetrigger.mockRejectedValue(retriggerErr('RATE_LIMITED', 'Too many build re-triggers'));
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('NOT_RETRIGGERABLE maps to BAD_REQUEST and surfaces the reason to the mod', async () => {
    mockRetrigger.mockRejectedValue(
      retriggerErr('NOT_RETRIGGERABLE', 'This version is already deployed.')
    );
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This version is already deployed.',
    });
  });

  it('TRIGGER_FAILED maps to INTERNAL_SERVER_ERROR, not a 400', async () => {
    // A build-service outage is OUR fault. Reporting it as BAD_REQUEST told the
    // moderator they had sent a malformed request and kept a real incident off
    // the server-fault error board.
    mockRetrigger.mockRejectedValue(
      retriggerErr('TRIGGER_FAILED', 'The build re-trigger could not be sent to the build service.')
    );
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('INVALID_STORED_SHA maps to BAD_REQUEST', async () => {
    mockRetrigger.mockRejectedValue(
      retriggerErr('INVALID_STORED_SHA', 'Request has no valid committed sha to rebuild.')
    );
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('an untyped error still maps to BAD_REQUEST rather than escaping raw', async () => {
    mockRetrigger.mockRejectedValue(new Error('kaboom'));
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.retriggerBuild({ publishRequestId: REQ_ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
