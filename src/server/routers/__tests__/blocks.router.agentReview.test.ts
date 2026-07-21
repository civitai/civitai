import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P2) — gate coverage for the READ path
 * blocks.getAgentReview (+ a CONFLICT-preservation check on startAgentReview)
 * through the REAL router.
 *
 * getAgentReview stacks three gates: moderatorProcedure (isModerator),
 * enforceAppBlocksFlag (the user-visibility flag), and the dedicated mod-only
 * `app-blocks-agentic-review` flag. We prove:
 *   - moderator + all flags on → reaches getAgentReport with the request id;
 *     null passes through when the app has no report.
 *   - non-moderator / anonymous → UNAUTHORIZED (service NOT reached).
 *   - moderator but the agentic-review flag OFF → UNAUTHORIZED (DARK / fail-closed,
 *     the as-merged posture since the Flipt flag does not exist yet).
 *   - startAgentReview preserves the service's CONFLICT ("already running") code
 *     instead of flattening it to BAD_REQUEST (the P2 panel keys on it).
 *
 * Mock surface mirrors blocks.router.reviewSandbox.test.ts so importing the
 * router doesn't drag in the generated Prisma client.
 */

const {
  mockIsAppBlocksEnabled,
  mockIsReviewSandboxEnabled,
  mockIsAgenticEnabled,
  mockGetAgentReport,
  mockStartAgentReview,
  mockPreviewRequest,
  mockGetReviewStatus,
  mockMintReviewBlockToken,
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
  mockIsAgenticEnabled: vi.fn(),
  mockGetAgentReport: vi.fn(),
  mockStartAgentReview: vi.fn(),
  mockPreviewRequest: vi.fn(),
  mockGetReviewStatus: vi.fn(),
  mockMintReviewBlockToken: vi.fn(),
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
  isAppBlocksAgenticReviewEnabled: mockIsAgenticEnabled,
}));
vi.mock('~/server/services/blocks/app-review-report.service', () => ({
  getAgentReport: mockGetAgentReport,
}));
vi.mock('~/server/services/blocks/agent-review.service', () => ({
  startAgentReview: mockStartAgentReview,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  previewRequest: mockPreviewRequest,
  getReviewStatus: mockGetReviewStatus,
  mintReviewBlockToken: mockMintReviewBlockToken,
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
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>(
    '@civitai/redis/client'
  );
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

const REPORT = {
  id: 'arar_1',
  publishRequestId: PUBREQ,
  slug: 'my-app',
  kind: 'onsite',
  version: '1.0.0',
  status: 'complete',
  model: 'test-model',
  codeReview: { findings: [] },
  securityAudit: { findings: [] },
  scopeVerdicts: { scopes: [] },
  summaryMd: 'ok',
  costUsd: '0.010000',
  tokenUsage: { promptTokens: 10, completionTokens: 5 },
};

beforeEach(() => {
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
  mockIsReviewSandboxEnabled.mockReset();
  mockIsReviewSandboxEnabled.mockImplementation(fakePerUserFlag);
  mockIsAgenticEnabled.mockReset();
  mockIsAgenticEnabled.mockImplementation(fakePerUserFlag); // on for mods by default
  mockGetAgentReport.mockReset();
  mockGetAgentReport.mockResolvedValue(REPORT);
  mockStartAgentReview.mockReset();
  mockStartAgentReview.mockResolvedValue({ reportId: 'arar_1', status: 'running' });
});

describe('blocks.getAgentReview', () => {
  it('moderator + flags on: reaches getAgentReport with the request id and returns the report', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getAgentReview({ publishRequestId: PUBREQ });
    expect(res?.status).toBe('complete');
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ);
  });

  it('moderator + flags on, no report: returns null', async () => {
    mockGetAgentReport.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getAgentReview({ publishRequestId: PUBREQ });
    expect(res).toBeNull();
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ);
  });

  it('non-moderator: UNAUTHORIZED, service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getAgentReview({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetAgentReport).not.toHaveBeenCalled();
  });

  it('anonymous: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.getAgentReview({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetAgentReport).not.toHaveBeenCalled();
  });

  it('moderator but the agentic-review flag OFF (flag-absent, fail-closed): UNAUTHORIZED (dark)', async () => {
    mockIsAgenticEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAgentReview({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockGetAgentReport).not.toHaveBeenCalled();
  });
});

describe('blocks.startAgentReview — CONFLICT preservation', () => {
  it('moderator + flags on: reaches the service with the server-derived modUserId', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.startAgentReview({ publishRequestId: PUBREQ });
    expect(res).toMatchObject({ status: 'running' });
    expect(mockStartAgentReview).toHaveBeenCalledWith({ publishRequestId: PUBREQ, modUserId: 1 });
  });

  it('a service CONFLICT ("already running") is preserved as CONFLICT, not flattened to BAD_REQUEST', async () => {
    mockStartAgentReview.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'a review is already running for this request' })
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.startAgentReview({ publishRequestId: PUBREQ })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('an opaque (non-TRPC) service error collapses to BAD_REQUEST', async () => {
    mockStartAgentReview.mockRejectedValue(new Error('kaboom'));
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.startAgentReview({ publishRequestId: PUBREQ })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('moderator but the agentic-review flag OFF: UNAUTHORIZED, service NOT reached', async () => {
    mockIsAgenticEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.startAgentReview({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockStartAgentReview).not.toHaveBeenCalled();
  });
});
