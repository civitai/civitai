import type * as StepsModule from '~/server/services/blocks/steps';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUTER-LEVEL proof that the `'textOutput'` posture is wired, not merely
 * implemented.
 *
 * 🔴 WHY THIS FILE EXISTS ON TOP OF THE SERVICE-LEVEL SUITE. The service suite
 * (`services/blocks/steps/__tests__/step-text-output-moderation.test.ts`) proves
 * `attachModeratedStepTextOutputs` withholds. That is a statement about a
 * function. It says nothing about whether any *procedure a block can call*
 * routes through it — and "the guard is correct but unreachable" is the exact
 * shape of an inert feature. So these drive the real tRPC procedures
 * (`blocks.pollWorkflow`, `blocks.cancelWorkflow`), the two surfaces a block
 * receives a finished generation on, and assert the generated string is not in
 * the payload they return.
 *
 * Every withhold assertion is PAIRED with a positive control that changes ONLY
 * the scan verdict — otherwise "the text is absent" would be equally consistent
 * with a harness that never produced any text at all.
 *
 * Mock strategy mirrors `blocks.router.appSubqueue.test.ts`: every dependency at
 * the module boundary, so the router runs in-process.
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
  mockCheckBlockCatalogRateLimit,
  mockGetSessionUser,
  mockDbRead,
  mockRedis,
  mockSysRedis,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockCreateXGuardModerationRequest,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCancelWorkflow: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
  mockGetUserById: vi.fn(),
  mockCheckBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  mockGetSessionUser: vi.fn(),
  mockDbRead: {
    modelVersion: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    modelBlockInstall: { findUnique: vi.fn() },
    blockUserSettings: { findUnique: vi.fn() },
    modelMetric: { findFirst: vi.fn() },
  },
  mockRedis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    incrBy: vi.fn(async () => 1),
    decrBy: vi.fn(async () => 0),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => -1),
    exists: vi.fn(async () => 0),
  },
  mockSysRedis: {
    get: vi.fn(async () => null),
    incrBy: vi.fn(async () => 0),
    decrBy: vi.fn(async () => 0),
    expire: vi.fn(async () => true),
    ttl: vi.fn(async () => -1),
  },
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsAppBlocksAuthorEnabled: vi.fn(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  ),
  mockCreateXGuardModerationRequest: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
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
  blockWorkflowOwnedByAppUser: vi.fn(async () => true),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  updateBlockWorkflowStatus: vi.fn(async () => undefined),
  listMyBlockWorkflows: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: mockGetUserById }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {
    modelBlockInstall: { findUnique: vi.fn() },
    model: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const { completeKeys } = vi.hoisted(() => {
  const group = (explicit: Record<string, string>, name: string): Record<string, string> =>
    new Proxy(explicit, {
      get: (t, k) =>
        k in t
          ? (t as Record<string, string>)[k as string]
          : typeof k === 'string'
          ? `mock:${name}:${k}`
          : (t as Record<string, string>)[k as string],
    });
  const completeKeys = (explicit: Record<string, Record<string, string>>) =>
    new Proxy(explicit, {
      get: (t, g) =>
        g in t
          ? group((t as Record<string, Record<string, string>>)[g as string], g as string)
          : typeof g === 'string'
          ? group({}, g)
          : (t as Record<string, Record<string, string>>)[g as string],
    });
  return { completeKeys };
});
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: completeKeys({ BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } }),
  REDIS_SYS_KEYS: completeKeys({ BLOCKS: { BUZZ_CAP: 'system:blocks:buzz-cap' } }),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...args: unknown[]) => mockCheckBlockCatalogRateLimit(...args),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

// The scanner + its log. Everything else about the moderation path is REAL.
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createXGuardModerationRequest: mockCreateXGuardModerationRequest };
});
vi.mock('~/server/logging/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, logToAxiom: mockLogToAxiom };
});

// 🔴 A `'textOutput'` STEP IS INJECTED INTO THE REGISTRY LOOKUP so these cases
// own their fixture instead of riding on whichever real entry happens to declare
// the posture (`chat-completion` does today — this file predates it and asserted
// none existed yet). Without an entry the read path has nothing to dispatch on
// and these tests would silently assert nothing; the `assertStepInvariants`
// control below is what keeps the fixture a genuinely registrable entry.
// ONLY `getStepByOrchestratorType` is overridden; every gate, invariant and
// posture declaration is the real one.
const registryOverride = new Map<string, unknown>();
vi.mock('~/server/services/blocks/steps', async (importOriginal) => {
  const actual = await importOriginal<StepsModule>();
  return {
    ...actual,
    getStepByOrchestratorType: (t: string) =>
      registryOverride.get(t) ?? actual.getStepByOrchestratorType(t),
  };
});

import * as z from 'zod';
import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { assertStepInvariants, type AnyBlockStep } from '~/server/services/blocks/steps';
import {
  TEXT_OUTPUT_SCAN_LABELS,
  TEXT_OUTPUT_WITHHELD_MESSAGE,
  __clearTextOutputVerdictCacheForTests,
} from '~/server/services/blocks/steps/text-output-moderation';

const CHAT_TYPE = 'fixtureChat';
const GENERATED_TEXT = 'the model wrote this exact sentence';

// 🔴 THE FOUR TOKEN IDS, PAIRWISE DISTINCT AND EACH SHAPED LIKE THE REAL THING.
// The telemetry assertions below discriminate `appBlockId` from `blockId`, and a
// fixture whose ids were equal (or empty) could not tell a right fix from a wrong
// one — it would pass with either claim wired in. `APP_BLOCK_ID` is a real
// `apb_<ulid>` (`AppBlock.id`, the PK); `BLOCK_SLUG` is what `AppBlock.blockId`
// actually holds — the publish request's SLUG, a human-readable repo name, not an
// id; `APP_ID` is the OauthClient id; `BLOCK_INSTANCE_ID` the per-render instance.
const APP_BLOCK_ID = 'apb_01JQ8XG7YV2K4M6P8R0T2W4Y6A';
const BLOCK_SLUG = 'pixel-poet';
const APP_ID = 'oac_01JQ8XG7YV2K4M6P8R0T2W4Y6B';
const BLOCK_INSTANCE_ID = 'bki_01JQ8XG7YV2K4M6P8R0T2W4Y6C';

const TEXT_OUTPUT_SCAN_EVENT = 'block-step-text-output-moderation';

/** Every `block-step-text-output-moderation` payload the run emitted. */
function scanLogPayloads(): Array<Record<string, unknown>> {
  return mockLogToAxiom.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((p) => p?.name === TEXT_OUTPUT_SCAN_EVENT);
}

const textStep: AnyBlockStep = {
  id: 'fixture-chat',
  orchestratorType: CHAT_TYPE,
  billingMode: 'prepaidFixed',
  moderationPosture: 'textOutput',
  resourcePolicy: { kind: 'none' },
  paramSchema: z.object({ value: z.number().int().min(1).max(10) }).strict(),
  variants: ['default'],
  resolveVariant: () => 'default',
  canonicalParamsFor: () => ({ value: 1 }),
  priceForVariant: () => 7,
  estimateBuzz: () => 7,
  buildStep: (p: { value: number }) => ({ $type: CHAT_TYPE, input: { value: p.value } }),
  // 🔴 NO `extractOutput`. A `'textOutput'` entry may not declare one (registry
  // clause 8-ii + `TextOutputSurface.extractOutput?: never`): `media.url` is a
  // bare string that reaches `snapshot.imageUrls` without meeting the scan.
  canonicalOutputFor: () => ({
    $type: CHAT_TYPE,
    output: { choices: [{ message: { content: 'canonical reply' } }] },
  }),
  extractText: (step: unknown) =>
    (
      (step as { output?: { choices?: Array<{ message?: { content?: string } }> } })?.output
        ?.choices ?? []
    )
      .map((c) => c.message?.content ?? '')
      .filter((t) => t.length > 0),
} as AnyBlockStep;

function chatWorkflow(content = GENERATED_TEXT) {
  return {
    id: 'wf_1',
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    cost: { total: 7 },
    steps: [
      {
        $type: CHAT_TYPE,
        name: 's',
        status: 'succeeded',
        metadata: {},
        output: { choices: [{ message: { content } }] },
      },
    ],
  };
}

function scanReturns(triggeredLabels: string[]) {
  mockCreateXGuardModerationRequest.mockResolvedValue({
    id: 'scan_wf',
    status: 'succeeded',
    steps: [
      {
        $type: 'xGuardModeration',
        output: {
          // 🔴 `blocked: false` even on a real hit — that is what the deployed
          // scanner returns for a `Scan`-action label, and reading it would
          // release everything here.
          blocked: false,
          triggeredLabels,
          // 🔴 ONE `results[]` ENTRY PER REQUESTED LABEL, triggered or not —
          // which is what the real scanner returns and what the label-drift
          // guard requires. A fixture that emitted results only for the
          // TRIGGERED labels would make every release in this file withhold for
          // the wrong reason, and the positive controls would die without ever
          // testing the policy. (That the fixture had to change is itself the
          // reachability proof for that guard.)
          results: TEXT_OUTPUT_SCAN_LABELS.map((label) => ({
            label,
            action: 'Scan',
            threshold: 0.5,
            score: triggeredLabels.includes(label) ? 0.98 : 0.02,
            triggered: triggeredLabels.includes(label),
          })),
        },
      },
    ],
  });
}

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: BLOCK_SLUG,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: BLOCK_INSTANCE_ID,
    ctx: { slotId: 'none', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
    ...over,
  };
}

function fakeCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

beforeEach(() => {
  for (const fn of [
    mockVerifyBlockToken,
    mockParseSubjectUserId,
    mockGetOrchestratorToken,
    mockGetWorkflow,
    mockCancelWorkflow,
    mockGetUserById,
    mockGetSessionUser,
    mockCheckBlockCatalogRateLimit,
    mockIsAppBlocksEnabled,
    mockIsAppBlocksAuthorEnabled,
    mockCreateXGuardModerationRequest,
    mockLogToAxiom,
  ]) {
    fn.mockReset();
  }
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockIsAppBlocksAuthorEnabled.mockImplementation(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  );
  mockGetUserById.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true, tier: 'free' });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  mockGetOrchestratorToken.mockResolvedValue('orch_token');
  mockCheckBlockCatalogRateLimit.mockResolvedValue({ allowed: true });
  mockLogToAxiom.mockResolvedValue(undefined);
  mockCancelWorkflow.mockResolvedValue(undefined);
  // 🔴 THE VERDICT MEMO IS MODULE-LIFETIME. Without this reset, a case that
  // withholds `GENERATED_TEXT` would answer the NEXT case's identical content
  // from cache — so the positive controls below would be asserting the previous
  // test's scan, and a broken policy could pass. Every pair in this file uses the
  // same fixture text on purpose (only the verdict differs), which is exactly
  // the shape the memo would collapse.
  __clearTextOutputVerdictCacheForTests();
  registryOverride.clear();
  registryOverride.set(CHAT_TYPE, textStep);
});

describe('blocks.pollWorkflow — textOutput moderation is WIRED', () => {
  it('the injected fixture is a genuinely registrable entry (the suite CONTROL)', () => {
    expect(() => assertStepInvariants('fixture-chat', textStep)).not.toThrow();
  });

  it('🔴 WITHHOLDS flagged generated text from the poll reply', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue(chatWorkflow());
    scanReturns(['Grooming']);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    // The whole payload the block receives — not just the field we happen to
    // know about.
    expect(JSON.stringify(result)).not.toContain(GENERATED_TEXT);
    expect(result.snapshot.textOutputs).toBeUndefined();
    expect(result.snapshot.textOutputWithheld).toEqual({ reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
    // The rest of the snapshot is unaffected.
    expect(result.snapshot.status).toBe('succeeded');
    expect(result.snapshot.cost).toEqual({ total: 7 });
  });

  it('🔴 POSITIVE CONTROL — the same poll DELIVERS the text on a clean scan', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue(chatWorkflow());
    scanReturns([]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    expect(result.snapshot.textOutputs).toEqual([GENERATED_TEXT]);
    expect(result.snapshot.textOutputWithheld).toBeUndefined();
  });

  it('WITHHOLDS when the scanner is down (fails CLOSED on the read path)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue(chatWorkflow());
    mockCreateXGuardModerationRequest.mockRejectedValue(new Error('scanner 503'));

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    expect(JSON.stringify(result)).not.toContain(GENERATED_TEXT);
    expect(result.snapshot.textOutputWithheld).toBeDefined();
    // 🔴 And the poll still SUCCEEDS. A scanner outage must not turn every poll
    // into a 500 — the caller has already paid and still needs status + cost.
    expect(result.snapshot.status).toBe('succeeded');
  });

  it('🔴 derives the SFW tier from the TOKEN CEILING, in both directions', async () => {
    // `Suggestive` is in the maturity-gated tier. A SFW-ceiling token withholds
    // it; a mature-allowed token does not. Nothing in the REQUEST differs — only
    // the server-minted claim. A handler reading a body field, or hardcoding
    // `isGreen`, passes exactly one of these.
    mockGetWorkflow.mockResolvedValue(chatWorkflow());
    const caller = blocksRouter.createCaller(fakeCtx() as never);

    scanReturns(['Suggestive']);
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag })
    );
    const sfw = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(sfw.snapshot.textOutputs).toBeUndefined();

    scanReturns(['Suggestive']);
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ maxBrowsingLevel: allBrowsingLevelsFlag })
    );
    const mature = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(mature.snapshot.textOutputs).toEqual([GENERATED_TEXT]);
  });

  it('a token with NO maturity claim gets the STRICT tier (fail closed)', async () => {
    mockGetWorkflow.mockResolvedValue(chatWorkflow());
    scanReturns(['NSFW']);
    mockVerifyBlockToken.mockResolvedValue(validClaims()); // no maxBrowsingLevel
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(result.snapshot.textOutputs).toBeUndefined();
  });

  it('a plain textToImage poll is UNCHANGED — no scan, no new keys', async () => {
    // 🔴 The regression guard for every existing block. This wiring must be
    // additive: the pre-existing image path must not gain a scan, a latency hit,
    // or a wire field.
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue({
      id: 'wf_1',
      status: 'succeeded',
      cost: { total: 10 },
      steps: [
        {
          $type: 'textToImage',
          name: 's',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'b', url: 'https://cdn/i.png', available: true }] },
        },
      ],
    });
    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
    expect(result.snapshot.imageUrls).toEqual(['https://cdn/i.png']);
    expect(Object.keys(result.snapshot).sort()).toEqual([
      'cost',
      'imageUrls',
      'status',
      'workflowId',
    ]);
  });

  it('🔴 keys the withhold TELEMETRY on AppBlock.id, not the publish slug', async () => {
    // 🔴 WHAT THIS PINS, AND WHY IT IS NOT COSMETIC. `appBlockId` on the scan
    // event is the per-app trigger-rate key this posture's design names as the
    // signal that matters (see `text-output-moderation`'s `logScan` comment). The
    // token carries THREE ids and they are different namespaces: `appBlockId` is
    // `AppBlock.id` (`apb_<ulid>`, the PK that `BlockScopeInvocation.app_block_id`
    // joins to), `blockId` is `AppBlock.blockId` — the publish request's SLUG —
    // and `blockInstanceId` is a per-render id. Logging the slug under the
    // `appBlockId` name joins to nothing, and because the value is only ever
    // logged (no column, no FK), the wrong one fails SILENTLY. So the assertion
    // has to name the exact value, not merely that the key exists.
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue(chatWorkflow());
    scanReturns(['Grooming']);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.pollWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    // POSITIVE CONTROL for the harness itself: a zero here would be
    // indistinguishable from a probe wired to nothing, and every assertion below
    // would pass vacuously over an empty array.
    const withheld = scanLogPayloads().filter((p) => p.stage === 'withheld');
    expect(withheld).toHaveLength(1);

    expect(withheld[0].appBlockId).toBe(APP_BLOCK_ID);
    // And explicitly NOT either of the two ids it is confusable with — the fixture
    // keeps all three distinct precisely so this can discriminate.
    expect(withheld[0].appBlockId).not.toBe(BLOCK_SLUG);
    expect(withheld[0].appBlockId).not.toBe(BLOCK_INSTANCE_ID);
    // The sibling key is unchanged — this fix must not shift `appId` too.
    expect(withheld[0].appId).toBe(APP_ID);
  });
});

describe('blocks.cancelWorkflow — the same boundary', () => {
  it('🔴 WITHHOLDS flagged text from a cancel reply', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue({ ...chatWorkflow(), status: 'canceled' });
    scanReturns(['Extremism']);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    expect(JSON.stringify(result)).not.toContain(GENERATED_TEXT);
    expect(result.snapshot.textOutputWithheld).toEqual({ reason: TEXT_OUTPUT_WITHHELD_MESSAGE });
  });

  it('🔴 POSITIVE CONTROL — the same cancel delivers the text on a clean scan', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue({ ...chatWorkflow(), status: 'canceled' });
    scanReturns([]);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    const result = await caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    expect(result.snapshot.textOutputs).toEqual([GENERATED_TEXT]);
  });

  it('🔴 derives the SFW tier from the TOKEN CEILING here too, in both directions', async () => {
    // 🔴 THIS TEST EXISTS BECAUSE THE MUTATION SWEEP FOUND ITS ABSENCE. With
    // only the always-withhold label asserted on this path, hardcoding
    // `isGreen: false` in the CANCEL wiring SURVIVED — the poll's equivalent
    // test could not see it, because each procedure passes its own `isGreen`.
    // Two call sites need two both-direction tests.
    mockGetWorkflow.mockResolvedValue({ ...chatWorkflow(), status: 'canceled' });
    const caller = blocksRouter.createCaller(fakeCtx() as never);

    scanReturns(['Suggestive']);
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag })
    );
    const sfw = await caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(sfw.snapshot.textOutputs).toBeUndefined();

    scanReturns(['Suggestive']);
    mockVerifyBlockToken.mockResolvedValue(
      validClaims({ maxBrowsingLevel: allBrowsingLevelsFlag })
    );
    const mature = await caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });
    expect(mature.snapshot.textOutputs).toEqual([GENERATED_TEXT]);
  });

  it('🔴 keys the withhold TELEMETRY on AppBlock.id here too', async () => {
    // 🔴 TWO CALL SITES NEED TWO TESTS — the same lesson the both-directions
    // maturity test above records. `cancelWorkflow` passes its own id argument, so
    // the poll's assertion cannot see a wrong one here.
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockGetWorkflow.mockResolvedValue({ ...chatWorkflow(), status: 'canceled' });
    scanReturns(['Extremism']);

    const caller = blocksRouter.createCaller(fakeCtx() as never);
    await caller.cancelWorkflow({ blockToken: 'tok', workflowId: 'wf_1' });

    const withheld = scanLogPayloads().filter((p) => p.stage === 'withheld');
    expect(withheld).toHaveLength(1);
    expect(withheld[0].appBlockId).toBe(APP_BLOCK_ID);
    expect(withheld[0].appBlockId).not.toBe(BLOCK_SLUG);
    expect(withheld[0].appBlockId).not.toBe(BLOCK_INSTANCE_ID);
    expect(withheld[0].appId).toBe(APP_ID);
  });
});
