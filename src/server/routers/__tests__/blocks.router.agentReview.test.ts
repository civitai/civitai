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
  mockIsListingsAgenticEnabled,
  mockGetAgentReport,
  mockListAgentReports,
  mockStartAgentReview,
  mockAgentReviewChat,
  mockPreviewRequest,
  mockGetReviewStatus,
  mockMintReviewBlockToken,
  mockTeardownPreview,
  mockListActivePreviews,
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetUserById,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsReviewSandboxEnabled: vi.fn(),
  mockIsAgenticEnabled: vi.fn(),
  mockIsListingsAgenticEnabled: vi.fn(),
  mockGetAgentReport: vi.fn(),
  mockListAgentReports: vi.fn(),
  mockStartAgentReview: vi.fn(),
  mockAgentReviewChat: vi.fn(),
  mockPreviewRequest: vi.fn(),
  mockGetReviewStatus: vi.fn(),
  mockMintReviewBlockToken: vi.fn(),
  mockTeardownPreview: vi.fn(),
  mockListActivePreviews: vi.fn(),
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksReviewSandboxEnabled: mockIsReviewSandboxEnabled,
  isAppBlocksAgenticReviewEnabled: mockIsAgenticEnabled,
  isAppListingsAgenticReviewEnabled: mockIsListingsAgenticEnabled,
}));
vi.mock('~/server/services/blocks/app-review-report.service', () => ({
  getAgentReport: mockGetAgentReport,
  listAgentReports: mockListAgentReports,
}));
vi.mock('~/server/services/blocks/agent-review.service', () => ({
  startAgentReview: mockStartAgentReview,
  agentReviewChat: mockAgentReviewChat,
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
import { getAgentReviewModelOptions } from '~/server/services/blocks/agent-review-models.service';
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
  // The CONNECT lane's own flag: OFF by default, as it ships.
  mockIsListingsAgenticEnabled.mockReset();
  mockIsListingsAgenticEnabled.mockResolvedValue(false);
  mockGetAgentReport.mockReset();
  mockGetAgentReport.mockResolvedValue(REPORT);
  mockStartAgentReview.mockReset();
  mockStartAgentReview.mockResolvedValue({ reportId: 'arar_1', status: 'running' });
  mockAgentReviewChat.mockReset();
  mockAgentReviewChat.mockResolvedValue({ reply: 'because scope X is used in wallet.js:10' });
  mockListAgentReports.mockReset();
  mockListAgentReports.mockResolvedValue([]);
  getAgentReviewModelOptions.clear();
  vi.unstubAllGlobals();
});

describe('blocks.getAgentReview', () => {
  it('moderator + flags on: reaches getAgentReport with the request id and returns the report', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getAgentReview({ publishRequestId: PUBREQ });
    expect(res?.status).toBe('complete');
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ, undefined);
  });

  it('moderator + flags on, no report: returns null', async () => {
    mockGetAgentReport.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.getAgentReview({ publishRequestId: PUBREQ });
    expect(res).toBeNull();
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ, undefined);
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
    expect(mockStartAgentReview).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      modUserId: 1,
      sections: undefined,
    });
    // 🔴 WHAT THE `sections: undefined` ABOVE DOES AND DOES NOT CLAIM. `toHaveBeenCalledWith`
    // uses `toEqual` semantics, under which an ABSENT key and an explicitly-`undefined` key
    // are equal. So that line does catch `sections: ['codeReview']`, and it cannot
    // distinguish "the router omitted the key" from "the router passed it as undefined" —
    // which is fine, because the service branches on the VALUE, not on key presence.
    // It is restated below as its own assertion for one reason: a failure there names
    // `sections` and prints the offending value, where the matcher above fails with a whole-
    // object diff in which the one field that matters is easy to miss.
    const call = mockStartAgentReview.mock.calls[0][0] as { sections?: unknown };
    expect(call.sections, 'a plain dispatch must be a FULL run').toBeUndefined();
  });

  it('🔴 forwards an optional `sections` list (the targeted re-run of ONE failed analysis)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.startAgentReview({ publishRequestId: PUBREQ, sections: ['codeReview'] });
    expect(mockStartAgentReview).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      modUserId: 1,
      sections: ['codeReview'],
    });
  });

  it('🔴 REFUSES a section name that is not one of the three — the input is user-supplied', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.startAgentReview({
        publishRequestId: PUBREQ,
        // @ts-expect-error — deliberately outside the enum; the zod schema is the gate.
        sections: ['summaryMd'],
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockStartAgentReview).not.toHaveBeenCalled();
  });

  it('🔴 REFUSES an EMPTY section list rather than treating it as "run everything"', async () => {
    // `[]` is an instruction to run nothing, which is not a thing the runner can do; the
    // way to ask for a full run is to omit the field. Accepting `[]` would make the
    // service's `length > 0` test the only thing standing between a mod and a no-op
    // dispatch they were charged a pod for.
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.startAgentReview({ publishRequestId: PUBREQ, sections: [] })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockStartAgentReview).not.toHaveBeenCalled();
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

describe('blocks.agentReviewChat', () => {
  const CHAT_INPUT = {
    publishRequestId: PUBREQ,
    messages: [{ role: 'user' as const, content: 'why did you flag scope X?' }],
  };

  it('moderator + flags on: reaches the service with the id + messages, returns the reply', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const res = await caller.agentReviewChat(CHAT_INPUT);
    expect(res).toEqual({ reply: 'because scope X is used in wallet.js:10' });
    expect(mockAgentReviewChat).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      messages: CHAT_INPUT.messages,
    });
  });

  it('non-moderator: UNAUTHORIZED, service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.agentReviewChat(CHAT_INPUT)).rejects.toBeInstanceOf(TRPCError);
    expect(mockAgentReviewChat).not.toHaveBeenCalled();
  });

  it('anonymous: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.agentReviewChat(CHAT_INPUT)).rejects.toBeInstanceOf(TRPCError);
    expect(mockAgentReviewChat).not.toHaveBeenCalled();
  });

  it('moderator but the agentic-review flag OFF (fail-closed): UNAUTHORIZED (dark)', async () => {
    mockIsAgenticEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.agentReviewChat(CHAT_INPUT)).rejects.toBeInstanceOf(TRPCError);
    expect(mockAgentReviewChat).not.toHaveBeenCalled();
  });

  it('preserves a service PRECONDITION_FAILED (pod not up), not flattened to BAD_REQUEST', async () => {
    mockAgentReviewChat.mockRejectedValue(
      new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the review agent is not available' })
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.agentReviewChat(CHAT_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('preserves a service BAD_GATEWAY (agent unreachable), not flattened to BAD_REQUEST', async () => {
    mockAgentReviewChat.mockRejectedValue(
      new TRPCError({ code: 'BAD_GATEWAY', message: 'the review agent did not respond' })
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.agentReviewChat(CHAT_INPUT)).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });

  it('an opaque (non-TRPC) service error collapses to BAD_REQUEST (no 500 leak)', async () => {
    mockAgentReviewChat.mockRejectedValue(new Error('kaboom'));
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.agentReviewChat(CHAT_INPUT)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // A previous reply is re-sent as history on every later turn. A detailed answer runs well
  // past the moderator's 4,000-character message cap, and used to fail the next turn.
  const withPreviousReply = (reply: string) => ({
    publishRequestId: PUBREQ,
    messages: [
      { role: 'user' as const, content: 'walk me through every finding' },
      { role: 'assistant' as const, content: reply },
      { role: 'user' as const, content: 'continue' },
    ],
  });

  it('🔴 a long previous assistant reply is accepted as history, not rejected BAD_REQUEST', async () => {
    const reply = 'x'.repeat(16_000);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.agentReviewChat(withPreviousReply(reply))).resolves.toEqual({
      reply: 'because scope X is used in wallet.js:10',
    });
    expect(mockAgentReviewChat.mock.calls[0][0].messages[1]).toEqual({
      role: 'assistant',
      content: reply,
    });
  });

  it('an assistant message takes up to 32,000 characters; one more is rejected', async () => {
    const cap = 32_000; // pinned literal, not the exported constant
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.agentReviewChat(withPreviousReply('x'.repeat(cap)))).resolves.toBeTruthy();
    await expect(
      caller.agentReviewChat(withPreviousReply('x'.repeat(cap + 1)))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockAgentReviewChat).toHaveBeenCalledTimes(1);
  });

  it('a moderator message is still capped at 4,000 characters', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.agentReviewChat({
        publishRequestId: PUBREQ,
        messages: [{ role: 'user', content: 'x'.repeat(4001) }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockAgentReviewChat).not.toHaveBeenCalled();
  });
});

describe('agent review CONNECT lane — gated on its own flag', () => {
  const ALPR = 'alpr_0123456789ABCDEFGHJKMNPQRS';
  const CHAT = [{ role: 'user' as const, content: 'why offline?' }];

  it('🔴 connect flag OFF (as shipped), on-site flag ON: start, read and chat all refuse; no dispatch', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.startAgentReview({ publishRequestId: ALPR })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.getAgentReview({ publishRequestId: ALPR })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller.agentReviewChat({ publishRequestId: ALPR, messages: CHAT })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockStartAgentReview).not.toHaveBeenCalled();
    expect(mockGetAgentReport).not.toHaveBeenCalled();
    expect(mockAgentReviewChat).not.toHaveBeenCalled();
    // The on-site flag was never the one asked about a connect request.
    expect(mockIsAgenticEnabled).not.toHaveBeenCalled();
  });

  it('connect flag ON (on-site flag OFF): a moderator dispatches the connect request', async () => {
    mockIsListingsAgenticEnabled.mockImplementation(fakePerUserFlag);
    mockIsAgenticEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.startAgentReview({ publishRequestId: ALPR });
    expect(mockStartAgentReview).toHaveBeenCalledWith({
      publishRequestId: ALPR,
      modUserId: 1,
      sections: undefined,
    });
    expect(mockIsListingsAgenticEnabled).toHaveBeenCalledWith({ user: modUser });
  });

  it('connect flag ON does not open the ON-SITE lane', async () => {
    mockIsListingsAgenticEnabled.mockImplementation(fakePerUserFlag);
    mockIsAgenticEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.startAgentReview({ publishRequestId: PUBREQ })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockStartAgentReview).not.toHaveBeenCalled();
  });

  it('connect flag ON still requires a moderator', async () => {
    mockIsListingsAgenticEnabled.mockResolvedValue(true);
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.startAgentReview({ publishRequestId: ALPR })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockStartAgentReview).not.toHaveBeenCalled();
  });
});

describe('agent review — choosing a model and a run', () => {
  it('startAgentReview forwards a chosen OpenRouter model id to the service', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.startAgentReview({ publishRequestId: PUBREQ, model: 'openai/gpt-4o-mini:free' });
    expect(mockStartAgentReview).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      modUserId: 1,
      sections: undefined,
      model: 'openai/gpt-4o-mini:free',
    });
  });

  it.each([
    ['no vendor', 'gpt-4o'],
    ['upper case', 'OpenAI/GPT-4o'],
    ['a space', 'openai/gpt 4o'],
    ['shell/template characters', 'openai/gpt-4o${HOME}'],
    ['a quote', 'openai/gpt-4o"'],
    ['a second slash', 'openai/gpt/4o'],
    ['too long', `a/${'b'.repeat(127)}`],
    ['empty', ''],
  ])('🔴 startAgentReview REFUSES a model id with %s, before the service', async (_why, model) => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.startAgentReview({ publishRequestId: PUBREQ, model })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockStartAgentReview).not.toHaveBeenCalled();
  });

  it('getAgentReview forwards the chosen run id (looked up within the request)', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await caller.getAgentReview({ publishRequestId: PUBREQ, reportId: 'arar_old' });
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ, 'arar_old');
  });

  it('agentReviewChat forwards the run on screen, so the chat grounds on it', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    const messages = [{ role: 'user' as const, content: 'why?' }];
    await caller.agentReviewChat({ publishRequestId: PUBREQ, messages, reportId: 'arar_old' });
    expect(mockAgentReviewChat).toHaveBeenCalledWith({
      publishRequestId: PUBREQ,
      messages,
      reportId: 'arar_old',
    });
  });
});

describe('blocks.listAgentReviews — gated identically to getAgentReview', () => {
  const RUNS = [
    { id: 'arar_2', model: 'openrouter/b/m', status: 'complete', costUsd: 0.02 },
    { id: 'arar_1', model: 'openrouter/a/m', status: 'failed', costUsd: 0 },
  ];

  it('moderator + flags on: every run of the request', async () => {
    mockListAgentReports.mockResolvedValue(RUNS);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.listAgentReviews({ publishRequestId: PUBREQ })).resolves.toEqual(RUNS);
    expect(mockListAgentReports).toHaveBeenCalledWith(PUBREQ);
  });

  it('non-moderator: UNAUTHORIZED, service NOT reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.listAgentReviews({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockListAgentReports).not.toHaveBeenCalled();
  });

  it('anonymous: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listAgentReviews({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockListAgentReports).not.toHaveBeenCalled();
  });

  it('moderator but the agentic-review flag OFF: UNAUTHORIZED (dark)', async () => {
    mockIsAgenticEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.listAgentReviews({ publishRequestId: PUBREQ })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockListAgentReports).not.toHaveBeenCalled();
  });

  it('a connect request with the connect flag OFF: UNAUTHORIZED', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(
      caller.listAgentReviews({ publishRequestId: 'alpr_0123456789ABCDEFGHJKMNPQRS' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockListAgentReports).not.toHaveBeenCalled();
  });
});

describe('blocks.getAgentReviewModels', () => {
  const MODELS_BODY = {
    data: [
      {
        id: 'anthropic/claude-haiku-4.5',
        name: 'Anthropic: Claude Haiku 4.5',
        context_length: 200000,
        pricing: { prompt: '0.000001', completion: '0.000005' },
        supported_parameters: ['tools'],
      },
      // Above the $5/M input-price ceiling: never offered.
      {
        id: 'acme/premium',
        name: 'Acme: Premium',
        pricing: { prompt: '0.000015', completion: '0.000075' },
        supported_parameters: ['tools'],
      },
    ],
  };

  it('moderator + flags on: the tool-capable models within the price ceiling, with their prices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => MODELS_BODY }))
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAgentReviewModels({ publishRequestId: PUBREQ })).resolves.toEqual({
      available: true,
      models: [
        {
          id: 'anthropic/claude-haiku-4.5',
          name: 'Anthropic: Claude Haiku 4.5',
          promptPerM: 1,
          completionPerM: 5,
        },
      ],
    });
  });

  it('OpenRouter unreachable: answers `available: false` (the field still takes a typed id)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAgentReviewModels({ publishRequestId: PUBREQ })).resolves.toEqual({
      available: false,
      models: [],
    });
  });

  it('non-moderator: UNAUTHORIZED, nothing fetched', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const caller = blocksRouter.createCaller(fakeCtx(normalUser) as never);
    await expect(caller.getAgentReviewModels({ publishRequestId: PUBREQ })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('moderator but the agentic-review flag OFF: UNAUTHORIZED, nothing fetched', async () => {
    mockIsAgenticEnabled.mockResolvedValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const caller = blocksRouter.createCaller(fakeCtx(modUser) as never);
    await expect(caller.getAgentReviewModels({ publishRequestId: PUBREQ })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
