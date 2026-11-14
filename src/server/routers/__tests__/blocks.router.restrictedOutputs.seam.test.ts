import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 SEAM GUARD: no snapshot- or listing-producing PROCEDURE hands a block the url of a
 * RESTRICTED output.
 *
 * `block-output-restriction.test.ts` pins the rule on the two producer functions, and
 * `block-output-restriction.producer-ledger.test.ts` pins that every production call
 * site passes the token's ceiling. Neither runs a procedure, so neither sees a procedure
 * that post-processes, re-wraps or re-reads the workflow on its own. This runs each
 * block-reachable read of a finished workflow end to end through the real router with ONE
 * restricted fixture, and asserts the restricted url is absent from the WHOLE reply.
 *
 * The submit replies are covered in `blocks.router.workflow.test.ts` (that suite carries
 * the submit path's mocks). The estimate is a whatIf and has no output to restrict.
 *
 * Mock strategy copied from `blocks.router.workflowScope.test.ts`.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockGetOrchestratorToken,
  mockQueryWorkflows,
  mockGetWorkflow,
  mockCancelWorkflow,
  mockSubmitWorkflow,
  mockGetUserById,
  mockGetSessionUser,
  mockCheckBlockCatalogRateLimit,
  mockCheckBlockPublishRateLimit,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockUpdateBlockWorkflowStatus,
  mockBlockWorkflowOwnedByAppUser,
  mockSettleCustomComfySpend,
  mockPersistBlockWorkflowOutputImage,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  mockCheckBlockPublishRateLimit: vi.fn(async () => ({ allowed: true })),
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(async () => true),
  mockUpdateBlockWorkflowStatus: vi.fn(async () => undefined),
  mockBlockWorkflowOwnedByAppUser: vi.fn(async () => true),
  mockSettleCustomComfySpend: vi.fn(async () => undefined),
  mockPersistBlockWorkflowOutputImage: vi.fn(),
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  queryWorkflows: mockQueryWorkflows,
  getWorkflow: mockGetWorkflow,
  cancelWorkflow: mockCancelWorkflow,
  submitWorkflow: mockSubmitWorkflow,
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: (...a: unknown[]) => mockBlockWorkflowOwnedByAppUser(...(a as [])),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  updateBlockWorkflowStatus: mockUpdateBlockWorkflowStatus,
  listMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settleCustomComfySpend: mockSettleCustomComfySpend };
});
// The publish write itself (fetch + re-upload + Image row). Mocked so the session-binding
// cases can observe whether a publish happened at all.
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  persistBlockWorkflowOutputImage: (...a: unknown[]) =>
    mockPersistBlockWorkflowOutputImage(...(a as [])),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: mockGetUserById }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckBlockCatalogRateLimit(...(a as [])),
  // `publishGenerationOutputs` charges its OWN (image-weighted) bucket, not the catalog one.
  checkBlockPublishRateLimit: (...a: unknown[]) => mockCheckBlockPublishRateLimit(...(a as [])),
  // …and `pollWorkflow` charges a third, dedicated `:poll:` bucket. Always allowed here: this
  // file is about SCOPE, and a refusal would pre-empt the guard it exists to exercise.
  checkBlockPollRateLimit: async () => ({ allowed: true }),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.incr.mockImplementation(async () => 1);
redisMock.redis.incrBy.mockImplementation(async () => 1);
redisMock.redis.decrBy.mockImplementation(async () => 0);
redisMock.redis.expire.mockImplementation(async () => true);
redisMock.redis.ttl.mockImplementation(async () => -1);
redisMock.sysRedis.incrBy.mockImplementation(async () => 0);
redisMock.sysRedis.decrBy.mockImplementation(async () => 0);
redisMock.sysRedis.expire.mockImplementation(async () => true);
redisMock.sysRedis.ttl.mockImplementation(async () => -1);

const VIEWER = 42;
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const APP_TAG = `app-block:${APP_ID}`;
const OWN_ID = `${VIEWER}-20261114120000000`;

const OK_A = 'https://blobs.example.test/ok-a.png';
const SECRET = 'https://blobs.example.test/restricted-r.png';
const OK_B = 'https://blobs.example.test/ok-b.png';

/**
 * Three outputs; the MIDDLE one is R on a workflow whose `allowMatureContent` is false.
 * Middle, so a producer that drops it from `images` but not `outputs` (or the reverse)
 * shows up as a shifted index.
 */
function restrictedWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: OWN_ID,
    status: 'succeeded',
    createdAt: '2026-11-14T12:00:00.000Z',
    cost: { total: 17 },
    allowMatureContent: false,
    tags: ['civitai', 'app-block', APP_TAG],
    steps: [
      {
        $type: 'customComfy',
        name: 'block-custom-comfy',
        status: 'succeeded',
        output: {
          blobs: [
            { id: 'a', type: 'image', url: OK_A, available: true, nsfwLevel: 'pg' },
            { id: 's', type: 'image', url: SECRET, available: true, nsfwLevel: 'r' },
            { id: 'b', type: 'image', url: OK_B, available: true, nsfwLevel: 'pg13' },
          ],
        },
      },
    ],
    ...over,
  };
}

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'pixel-poet',
    appId: APP_ID,
    appBlockId: 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A',
    blockInstanceId: 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C',
    ctx: { slotId: 'none', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
    maxBrowsingLevel: sfwBrowsingLevelsFlag,
    ...over,
  };
}

type Session = { id: number } | null;
function fakeCtx(user: Session = null) {
  return {
    acceptableOrigin: true,
    user: user ?? undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}
const caller = (user: Session = null) => blocksRouter.createCaller(fakeCtx(user) as never);

beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockParseSubjectUserId,
    mockGetOrchestratorToken,
    mockQueryWorkflows,
    mockGetWorkflow,
    mockCancelWorkflow,
    mockGetUserById,
    mockGetSessionUser,
    mockCheckBlockCatalogRateLimit,
    mockCheckBlockPublishRateLimit,
    mockIsAppBlocksEnabled,
    mockIsAppBlocksAuthorEnabled,
    mockUpdateBlockWorkflowStatus,
    mockBlockWorkflowOwnedByAppUser,
    mockSettleCustomComfySpend,
    mockPersistBlockWorkflowOutputImage,
  ]) {
    fn.mockReset();
  }
  resetEnv();
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(async () => true);
  mockGetUserById.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: VIEWER, isModerator: false, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : VIEWER));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockCheckBlockPublishRateLimit.mockResolvedValue({ allowed: true });
  mockUpdateBlockWorkflowStatus.mockResolvedValue(undefined);
  mockBlockWorkflowOwnedByAppUser.mockResolvedValue(true);
  mockSettleCustomComfySpend.mockResolvedValue(undefined);
  mockCancelWorkflow.mockResolvedValue(undefined);
  mockGetWorkflow.mockResolvedValue(restrictedWorkflow());
  mockQueryWorkflows.mockResolvedValue({ items: [restrictedWorkflow()], nextCursor: undefined });
  let nextImageId = 701;
  mockPersistBlockWorkflowOutputImage.mockImplementation(async () => ({ imageId: nextImageId++ }));
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
});

afterEach(() => {
  resetEnv();
});

/** Every procedure a block reads a finished workflow through, and what it returns. */
const READS = {
  pollWorkflow: () => caller().pollWorkflow({ blockToken: 'tok', workflowId: OWN_ID }),
  cancelWorkflow: () => caller().cancelWorkflow({ blockToken: 'tok', workflowId: OWN_ID }),
  queryAppWorkflows: () => caller().queryAppWorkflows({ blockToken: 'tok' }),
  cancelAppWorkflow: () => caller().cancelAppWorkflow({ blockToken: 'tok', workflowId: OWN_ID }),
} as const;

// SFW token: the R output is above the ceiling. Mature token: the paying pool refused it.
const CASES = [
  ['an SFW app', sfwBrowsingLevelsFlag, 'ceiling'],
  ['a mature app', 1 | 2 | 4 | 8 | 16, 'pool'],
] as const;

describe.each(CASES)('restricted outputs never reach %s', (_label, maxBrowsingLevel, reason) => {
  beforeEach(() => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ maxBrowsingLevel }));
  });

  const EXPECTED_OUTPUTS = [
    { url: OK_A, nsfwLevel: 'pg' },
    { restricted: true, reason },
    { url: OK_B, nsfwLevel: 'pg13' },
  ];

  it.each(Object.keys(READS) as Array<keyof typeof READS>)(
    '%s: the restricted url is nowhere in the reply',
    async (procedure) => {
      const reply = await READS[procedure]();
      expect(JSON.stringify(reply)).not.toContain(SECRET);
      // POSITIVE CONTROL: the reply did carry the workflow's other outputs.
      expect(JSON.stringify(reply)).toContain(OK_B);
    }
  );

  it('pollWorkflow and cancelWorkflow: outputs keeps the position; imageUrls drops it', async () => {
    for (const procedure of ['pollWorkflow', 'cancelWorkflow'] as const) {
      const { snapshot } = await READS[procedure]();
      expect(snapshot.outputs).toStrictEqual(EXPECTED_OUTPUTS);
      expect(snapshot.imageUrls).toStrictEqual([OK_A, OK_B]);
    }
  });

  it('queryAppWorkflows and cancelAppWorkflow: images drops it; outputs keeps the position', async () => {
    const listed = (await READS.queryAppWorkflows()).workflows[0];
    const canceled = (await READS.cancelAppWorkflow()).workflow;
    for (const workflow of [listed, canceled]) {
      expect(workflow.images.map((i) => i.url)).toStrictEqual([OK_A, OK_B]);
      expect(workflow.outputs).toStrictEqual(EXPECTED_OUTPUTS);
    }
  });

  it('publishGenerationOutputs never fetches the restricted output', async () => {
    const all = await caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
    });
    expect(all).toEqual({ imageIds: [701, 702] });
    const fetched = mockPersistBlockWorkflowOutputImage.mock.calls.map(
      (c) => (c[0] as { imageUrl: string }).imageUrl
    );
    expect(fetched).toStrictEqual([OK_A, OK_B]);
  });

  it('publishGenerationOutputs: imageIndexes index the listing images, so [1] is OK_B', async () => {
    await caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
      imageIndexes: [1],
    });
    expect(
      mockPersistBlockWorkflowOutputImage.mock.calls.map(
        (c) => (c[0] as { imageUrl: string }).imageUrl
      )
    ).toStrictEqual([OK_B]);
  });
});

describe('CONTROL: the same workflow, mature content allowed', () => {
  it('a mature app is handed the R output in position', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ maxBrowsingLevel: 1 | 2 | 4 | 8 | 16 }));
    mockGetWorkflow.mockResolvedValue(restrictedWorkflow({ allowMatureContent: true }));
    const { snapshot } = await READS.pollWorkflow();
    expect(snapshot.imageUrls).toStrictEqual([OK_A, SECRET, OK_B]);
    expect(snapshot.outputs).toStrictEqual([
      { url: OK_A, nsfwLevel: 'pg' },
      { url: SECRET, nsfwLevel: 'r' },
      { url: OK_B, nsfwLevel: 'pg13' },
    ]);
  });
});
