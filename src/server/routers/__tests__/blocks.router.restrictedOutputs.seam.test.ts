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
/** The media-serve flag, off unless a test turns it on. */
const servingFlag = vi.hoisted(() => ({ on: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: async () => undefined,
  isFliptSync: (flag: string) =>
    flag === 'app-blocks-workflow-media-serve' ? servingFlag.on : false,
}));
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

import type * as FliptClient from '~/server/flipt/client';
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
    // A viewer whose own level allows everything, so the domain ceiling decides; the
    // viewer-level describe below overrides it.
    viewerBrowsingLevel: 1 | 2 | 4 | 8 | 16,
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

  it('publishGenerationOutputs: imageIndexes are positions in outputs, so [2] is OK_B', async () => {
    await caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
      imageIndexes: [2],
    });
    expect(
      mockPersistBlockWorkflowOutputImage.mock.calls.map(
        (c) => (c[0] as { imageUrl: string }).imageUrl
      )
    ).toStrictEqual([OK_B]);
  });

  it('publishGenerationOutputs REFUSES a restricted position and writes nothing', async () => {
    for (const imageIndexes of [[1], [0, 1], [1, 2]]) {
      await expect(
        caller({ id: VIEWER }).publishGenerationOutputs({
          blockToken: 'tok',
          workflowId: OWN_ID,
          imageIndexes,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'output 1 is restricted' });
    }
    expect(mockPersistBlockWorkflowOutputImage).not.toHaveBeenCalled();
  });

  it('a rating that lands late never moves a publish index: [2] is OK_B before and after', async () => {
    const unrated = restrictedWorkflow();
    const blobs = (unrated.steps[0].output as { blobs: Array<Record<string, unknown>> }).blobs;
    delete blobs[1].nsfwLevel;
    mockGetWorkflow.mockResolvedValueOnce(unrated);
    await caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
      imageIndexes: [2],
    });
    // Now rated R on the restricted workflow (the default fixture).
    await caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
      imageIndexes: [2],
    });
    expect(
      mockPersistBlockWorkflowOutputImage.mock.calls.map(
        (c) => (c[0] as { imageUrl: string }).imageUrl
      )
    ).toStrictEqual([OK_B, OK_B]);
  });
});

describe('🔴 F1 — an output still being rated is held, and naming it is refused', () => {
  /** The middle output has no rating yet; an SFW token's rating could still restrict it. */
  function unratedMiddle() {
    // Just finished: inside the rating hold (`isRatingHoldExpired`).
    const workflow = restrictedWorkflow({
      allowMatureContent: undefined,
      completedAt: new Date().toISOString(),
    });
    const blobs = (workflow.steps[0].output as { blobs: Array<Record<string, unknown>> }).blobs;
    delete blobs[1].nsfwLevel;
    return workflow;
  }

  beforeEach(() => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue(unratedMiddle());
  });

  it('pollWorkflow holds it: no url, ratingPending set', async () => {
    const { snapshot } = await READS.pollWorkflow();
    expect(snapshot.outputs).toStrictEqual([
      { url: OK_A, nsfwLevel: 'pg' },
      { pending: true },
      { url: OK_B, nsfwLevel: 'pg13' },
    ]);
    expect(snapshot.ratingPending).toBe(true);
    // The orchestrator says succeeded; an app is told processing, so an old SDK keeps polling.
    expect(snapshot.status).toBe('processing');
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("pollWorkflow's own bookkeeping keys on the REAL status while the app is told processing", async () => {
    mockUpdateBlockWorkflowStatus.mockResolvedValue(1 as never);
    const { snapshot } = await READS.pollWorkflow();
    expect(snapshot.status).toBe('processing');
    // The read model records the terminal status and settle runs now, not after the rating.
    expect(mockUpdateBlockWorkflowStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateBlockWorkflowStatus).toHaveBeenCalledWith({
      workflowId: OWN_ID,
      status: 'succeeded',
    });
    expect(mockSettleCustomComfySpend).toHaveBeenCalledTimes(1);
    expect(mockSettleCustomComfySpend).toHaveBeenCalledWith({
      workflowId: OWN_ID,
      actualCost: 17,
    });
  });

  it('publish of the pending position, or of "every output", is refused and writes nothing', async () => {
    for (const imageIndexes of [[1], undefined]) {
      await expect(
        caller({ id: VIEWER }).publishGenerationOutputs({
          blockToken: 'tok',
          workflowId: OWN_ID,
          ...(imageIndexes ? { imageIndexes } : {}),
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'output 1 is still being rated, try again shortly',
      });
    }
    expect(mockPersistBlockWorkflowOutputImage).not.toHaveBeenCalled();
  });

  it('a rated position beside it still publishes', async () => {
    await caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
      imageIndexes: [2],
    });
    expect(
      mockPersistBlockWorkflowOutputImage.mock.calls.map(
        (c) => (c[0] as { imageUrl: string }).imageUrl
      )
    ).toStrictEqual([OK_B]);
  });

  it('publish of a BLOCKED position is refused', async () => {
    const workflow = restrictedWorkflow({ allowMatureContent: undefined });
    const blobs = (workflow.steps[0].output as { blobs: Array<Record<string, unknown>> }).blobs;
    blobs[1].blockedReason = 'Moderated';
    mockGetWorkflow.mockResolvedValue(workflow);
    await expect(
      caller({ id: VIEWER }).publishGenerationOutputs({
        blockToken: 'tok',
        workflowId: OWN_ID,
        imageIndexes: [1],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'output 1 is not available' });
    expect(mockPersistBlockWorkflowOutputImage).not.toHaveBeenCalled();
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 The output ceiling is the VIEWER's level (#8786): the domain ceiling intersected
// with the token's `viewerBrowsingLevel`, PG without one, and for this SIGNED-IN viewer
// (`sub: user:42`) floored at PG|PG-13 first. Domain PG|PG13|R (7) on a workflow that
// allows mature content, so only the ceiling decides. Outputs pg (1), r (4), pg13 (2);
// viewers PG (1) and PG+R (5), pairwise distinct. A site that passed the domain ceiling
// would hand the PG viewer the R output; one without the floor would lock their PG-13.
describe("🔴 every read and publish judges outputs at the viewer's own level", () => {
  const DOMAIN_TO_R = 1 | 2 | 4;
  const VIEWERS = [
    [
      'a signed-in PG viewer (floored to PG-13)',
      { viewerBrowsingLevel: 1 },
      [
        { url: OK_A, nsfwLevel: 'pg' },
        { restricted: true, reason: 'ceiling' },
        { url: OK_B, nsfwLevel: 'pg13' },
      ],
    ],
    [
      'a token without a viewer level (PG, no floor)',
      { viewerBrowsingLevel: undefined },
      [
        { url: OK_A, nsfwLevel: 'pg' },
        { restricted: true, reason: 'ceiling' },
        { restricted: true, reason: 'ceiling' },
      ],
    ],
    [
      'a signed-in PG+R viewer (floored to PG-13)',
      { viewerBrowsingLevel: 1 | 4 },
      [
        { url: OK_A, nsfwLevel: 'pg' },
        { url: SECRET, nsfwLevel: 'r' },
        { url: OK_B, nsfwLevel: 'pg13' },
      ],
    ],
  ] as const;

  describe.each(VIEWERS)('%s, domain ceiling up to R', (_label, viewer, expected) => {
    beforeEach(() => {
      mockVerifyBlockToken.mockResolvedValue(
        validClaims({ maxBrowsingLevel: DOMAIN_TO_R, ...viewer })
      );
      mockGetWorkflow.mockResolvedValue(restrictedWorkflow({ allowMatureContent: true }));
      mockQueryWorkflows.mockResolvedValue({
        items: [restrictedWorkflow({ allowMatureContent: true })],
        nextCursor: undefined,
      });
    });
    const urls = expected.flatMap((o) => ('url' in o ? [o.url] : []));

    it('pollWorkflow and cancelWorkflow', async () => {
      for (const procedure of ['pollWorkflow', 'cancelWorkflow'] as const) {
        const { snapshot } = await READS[procedure]();
        expect(snapshot.outputs).toStrictEqual(expected);
        expect(snapshot.imageUrls).toStrictEqual(urls);
      }
    });

    it('queryAppWorkflows and cancelAppWorkflow', async () => {
      const listed = (await READS.queryAppWorkflows()).workflows[0];
      const canceled = (await READS.cancelAppWorkflow()).workflow;
      for (const workflow of [listed, canceled]) {
        expect(workflow.outputs).toStrictEqual(expected);
        expect(workflow.images.map((i) => i.url)).toStrictEqual(urls);
      }
    });

    it('publishGenerationOutputs fetches exactly the outputs the viewer may see', async () => {
      await caller({ id: VIEWER }).publishGenerationOutputs({
        blockToken: 'tok',
        workflowId: OWN_ID,
        imageIndexes: [0],
      });
      for (const position of [1, 2]) {
        const call = caller({ id: VIEWER }).publishGenerationOutputs({
          blockToken: 'tok',
          workflowId: OWN_ID,
          imageIndexes: [position],
        });
        if ('url' in expected[position]) await call;
        else
          await expect(call).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: `output ${position} is restricted`,
          });
      }
      expect(
        mockPersistBlockWorkflowOutputImage.mock.calls.map(
          (c) => (c[0] as { imageUrl: string }).imageUrl
        )
      ).toStrictEqual(urls);
    });
  });
});

describe('🔴 serving on: publish refuses what the poll restricts', () => {
  const NA = 'https://blobs.example.test/na.png';
  const withNa = () =>
    restrictedWorkflow({
      allowMatureContent: true,
      steps: [
        {
          $type: 'customComfy',
          name: 'block-custom-comfy',
          status: 'succeeded',
          output: {
            blobs: [
              { id: 'a', type: 'image', url: OK_A, available: true, nsfwLevel: 'pg' },
              { id: 'n', type: 'image', url: NA, available: true, nsfwLevel: 'na' },
              { id: 'b', type: 'image', url: OK_B, available: true, nsfwLevel: 'pg13' },
            ],
          },
        },
      ],
    });
  const publish = (imageIndexes: number[]) =>
    caller({ id: VIEWER }).publishGenerationOutputs({
      blockToken: 'tok',
      workflowId: OWN_ID,
      imageIndexes,
    });
  const fetched = () =>
    mockPersistBlockWorkflowOutputImage.mock.calls.map(
      (c) => (c[0] as { imageUrl: string }).imageUrl
    );

  beforeEach(() => {
    servingFlag.on = true;
    mockVerifyBlockToken.mockResolvedValue(validClaims({ maxBrowsingLevel: 1 | 2 | 4 | 8 | 16 }));
    mockGetWorkflow.mockResolvedValue(withNa());
  });
  afterEach(() => {
    servingFlag.on = false;
  });

  it('the poll restricts the `na` output in position', async () => {
    const { snapshot } = await READS.pollWorkflow();
    expect(snapshot.outputs?.[1]).toStrictEqual({ restricted: true, reason: 'unrated' });
  });

  it('publish refuses that position and writes nothing', async () => {
    await expect(publish([1])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'output 1 is restricted',
    });
    expect(mockPersistBlockWorkflowOutputImage).not.toHaveBeenCalled();
  });

  it('CONTROL: a rated position beside it publishes, from the orchestrator url', async () => {
    await publish([2]);
    expect(fetched()).toStrictEqual([OK_B]);
  });

  it('with serving off the same `na` position is refused too', async () => {
    servingFlag.on = false;
    await expect(publish([1])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'output 1 is restricted',
    });
    expect(mockPersistBlockWorkflowOutputImage).not.toHaveBeenCalled();
  });

  it('CONTROL: with serving off the rated position beside it publishes', async () => {
    servingFlag.on = false;
    await publish([2]);
    expect(fetched()).toStrictEqual([OK_B]);
  });
});
