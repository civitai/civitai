import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * MOD REVIEW SANDBOX (#2831) — gate coverage for blocks.previewRequest +
 * blocks.getReviewStatus through the REAL router.
 *
 * Both procedures stack three gates: moderatorProcedure (isModerator),
 * enforceAppBlocksFlag (the user-visibility flag), and the dedicated mod-only
 * `app-blocks-review-sandbox` flag. We prove:
 *   - moderator + both flags on  → previewRequest reaches the service with the
 *     server-derived modUserId; getReviewStatus reaches the service.
 *   - non-moderator              → UNAUTHORIZED (never reaches the service).
 *   - anonymous                  → UNAUTHORIZED.
 *   - moderator but review-sandbox flag OFF → UNAUTHORIZED (dark).
 *
 * Mock surface mirrors blocks.router.flag-gate.test.ts so importing the router
 * doesn't drag in the generated Prisma client.
 */

const {
  mockIsAppBlocksEnabled,
  mockIsReviewSandboxEnabled,
  mockPreviewRequest,
  mockGetReviewStatus,
  mockTeardownPreview,
  mockListActivePreviews,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
  mockLogToAxiom,
  mockRedis,
  mockSysRedis,
  mockDbRead,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsReviewSandboxEnabled: vi.fn(),
  mockPreviewRequest: vi.fn(),
  mockGetReviewStatus: vi.fn(),
  mockTeardownPreview: vi.fn(),
  mockListActivePreviews: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockRedis: { get: vi.fn(), set: vi.fn() },
  mockSysRedis: { get: vi.fn(), incrBy: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
  mockDbRead: {
    modelVersion: { findUnique: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    appBlockPublishRequest: { findMany: vi.fn() },
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksReviewSandboxEnabled: mockIsReviewSandboxEnabled,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  previewRequest: mockPreviewRequest,
  getReviewStatus: mockGetReviewStatus,
  teardownPreview: mockTeardownPreview,
  listActiveReviewPreviews: mockListActivePreviews,
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
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  return { ...actual, redis: mockRedis, sysRedis: mockSysRedis };
});
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: (...a: unknown[]) => mockGetUserBuzzAccounts(...a),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
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
const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockIsReviewSandboxEnabled.mockReset();
  mockIsReviewSandboxEnabled.mockImplementation(fakePerUserFlag); // on for mods by default
  mockPreviewRequest.mockReset();
  mockPreviewRequest.mockResolvedValue({
    publishRequestId: PUBREQ,
    slug: 'my-app',
    sha: 'a'.repeat(40),
    host: 'review-x.civit.ai',
    url: 'https://review-x.civit.ai/my-app',
    pipelineRun: 'pr-1',
  });
  mockGetReviewStatus.mockReset();
  mockGetReviewStatus.mockResolvedValue({
    publishRequestId: PUBREQ,
    status: 'pending',
    state: 'preview-live',
    detail: { url: 'https://review-x.civit.ai/my-app' },
    updatedAt: new Date(),
  });
  mockTeardownPreview.mockReset();
  mockTeardownPreview.mockResolvedValue({ publishRequestId: PUBREQ, tornDown: true });
  mockListActivePreviews.mockReset();
  mockListActivePreviews.mockResolvedValue({ cap: 5, active: [] });
});

describe('blocks.previewRequest', () => {
  it('moderator + flags on: reaches the service with the server modUserId', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.previewRequest({ publishRequestId: PUBREQ });
    expect(res.url).toBe('https://review-x.civit.ai/my-app');
    expect(mockPreviewRequest).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      modUserId: 1, // SERVER-derived, never client-supplied
    });
  });

  it('non-moderator: UNAUTHORIZED, service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.previewRequest({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockPreviewRequest).not.toHaveBeenCalled();
  });

  it('anonymous: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.previewRequest({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockPreviewRequest).not.toHaveBeenCalled();
  });

  it('moderator but review-sandbox flag OFF: UNAUTHORIZED (dark)', async () => {
    mockIsReviewSandboxEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.previewRequest({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockPreviewRequest).not.toHaveBeenCalled();
  });
});

describe('blocks.getReviewStatus', () => {
  it('moderator + flags on: returns the preview state', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getReviewStatus({ publishRequestId: PUBREQ });
    expect(res.state).toBe('preview-live');
    // The router passes the SERVER-derived mod id so getReviewStatus can mint the
    // fresh mod-bound previewUrl token when the preview is live.
    expect(mockGetReviewStatus).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      modUserId: 1,
    });
  });

  it('non-moderator: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getReviewStatus({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetReviewStatus).not.toHaveBeenCalled();
  });

  it('moderator but review-sandbox flag OFF: UNAUTHORIZED', async () => {
    mockIsReviewSandboxEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getReviewStatus({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetReviewStatus).not.toHaveBeenCalled();
  });
});

describe('blocks.teardownPreview', () => {
  it('moderator + flags on: reaches the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.teardownPreview({ publishRequestId: PUBREQ });
    expect(res.tornDown).toBe(true);
    expect(mockTeardownPreview).toHaveBeenCalledWith({ publishRequestId: PUBREQ });
  });

  it('non-moderator: UNAUTHORIZED, service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.teardownPreview({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockTeardownPreview).not.toHaveBeenCalled();
  });

  it('moderator but review-sandbox flag OFF: UNAUTHORIZED (dark)', async () => {
    mockIsReviewSandboxEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.teardownPreview({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockTeardownPreview).not.toHaveBeenCalled();
  });
});

describe('blocks.listActivePreviews', () => {
  it('moderator + flags on: returns the cap + active list', async () => {
    mockListActivePreviews.mockResolvedValue({
      cap: 5,
      active: [
        {
          publishRequestId: PUBREQ,
          slug: 'my-app',
          version: '1.0.0',
          state: 'preview-live',
          host: 'review-x.civit.ai',
          updatedAt: new Date(),
        },
      ],
    });
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.listActivePreviews();
    expect(res.cap).toBe(5);
    expect(res.active).toHaveLength(1);
    expect(mockListActivePreviews).toHaveBeenCalled();
  });

  it('non-moderator: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.listActivePreviews()).rejects.toBeInstanceOf(TRPCError);
    expect(mockListActivePreviews).not.toHaveBeenCalled();
  });

  it('moderator but review-sandbox flag OFF: UNAUTHORIZED', async () => {
    mockIsReviewSandboxEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.listActivePreviews()).rejects.toBeInstanceOf(TRPCError);
    expect(mockListActivePreviews).not.toHaveBeenCalled();
  });
});
