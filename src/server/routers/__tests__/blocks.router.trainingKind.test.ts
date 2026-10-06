import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as FeatureFlagsModule from '~/server/services/feature-flags.service';
import type * as AttributionModule from '~/server/services/blocks/buzz-attribution.service';
import type * as AuthorFeeChargeModule from '~/server/services/blocks/author-fee-charge.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as ImageUploadModule from '~/server/services/orchestrator/imageUpload';

/**
 * `kind:'training'` end-to-end through `blocksRouter`: dataset → estimate (quote) →
 * session-only consent → submit. The dataset and quote services and the cap
 * reservation helpers run FOR REAL over an in-memory Redis; only the orchestrator,
 * identity and feature-flag edges are stubbed.
 *
 * The property under test is the one the arm exists for: a training run can be
 * charged above the token's per-call budget ONLY against a quote its own subject
 * confirmed through a signed-in session, re-quoted at submit, single-use, and never
 * above the per-run ceiling — while every other cap still applies.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertEnabled: vi.fn(async () => undefined),
  trainingFlag: vi.fn(async () => true),
  features: vi.fn(() => ({ aiToolkitSdxl: true, trainingStepsPricing: true })),
  trainingStatus: vi.fn(async () => ({ available: true, blockedModels: [] as string[] })),
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
  submitWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  getUserById: vi.fn(async () => ({ id: 42, isModerator: false })),
  reserveAppSpend: vi.fn(async () => ({ allowed: true, dailyKey: 'app-daily' })),
  refundAppSpend: vi.fn(async () => undefined),
  persistSettle: vi.fn(async () => undefined),
  recordSpendAttribution: vi.fn(async () => undefined),
  chargeAuthorFee: vi.fn(),
  recordScopeInvocation: vi.fn(async () => undefined),
  publishRate: vi.fn(async () => ({ allowed: true })),
  datasetRate: vi.fn(async () => ({ allowed: true })),
  catalogRate: vi.fn(async () => ({ allowed: true })),
  imageUpload: vi.fn(),
  buzzAccounts: vi.fn(async () => ({ blue: 100, green: 200, yellow: 0 })),
  getActiveDevTunnel: vi.fn(async (): Promise<unknown> => null),
  reserveDevSessionBuzz: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BridgeAuthModule>()),
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenAccessModule>()),
  assertAppBlocksEnabledForTokenUser: (...a: unknown[]) => h.assertEnabled(...(a as [])),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagModule>()),
  isAppBlocksTrainingKindEnabled: (...a: unknown[]) => h.trainingFlag(...(a as [])),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  getFeatureFlagsLazy: () => h.features(),
}));
vi.mock('~/server/services/training.service', () => ({
  getTrainingServiceStatus: () => h.trainingStatus(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: () => h.getOrchestratorToken(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  deleteWorkflow: (...a: unknown[]) => h.deleteWorkflow(...(a as [])),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: (...a: unknown[]) => h.audit(...(a as [])),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: () => h.getUserById(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(async () => null),
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', () => ({
  reserveAppSpend: (...a: unknown[]) => h.reserveAppSpend(...(a as [])),
  refundAppSpend: (...a: unknown[]) => h.refundAppSpend(...(a as [])),
  chargeAppSpendOverage: vi.fn(),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => h.getActiveDevTunnel(...(a as [])),
  reserveDevSessionBuzz: (...a: unknown[]) => h.reserveDevSessionBuzz(...(a as [])),
  refundDevSessionBuzz: vi.fn(),
  chargeDevSessionOverage: vi.fn(),
}));
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  listMyBlockWorkflows: vi.fn(),
  updateBlockWorkflowStatus: vi.fn(),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', () => ({
  persistCustomComfySettle: (...a: unknown[]) => h.persistSettle(...(a as [])),
  settleCustomComfySpend: vi.fn(),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AttributionModule>()),
  recordSpendAttribution: (...a: unknown[]) => h.recordSpendAttribution(...(a as [])),
}));
vi.mock('~/server/services/blocks/author-fee-charge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthorFeeChargeModule>()),
  chargeBlockAuthorFee: (...a: unknown[]) => h.chargeAuthorFee(...(a as [])),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: (...a: unknown[]) => h.recordScopeInvocation(...(a as [])),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  checkBlockPublishRateLimit: (...a: unknown[]) => h.publishRate(...(a as [])),
  checkBlockTrainingDatasetRateLimit: (...a: unknown[]) => h.datasetRate(...(a as [])),
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogRate(...(a as [])),
}));
vi.mock('~/server/services/orchestrator/imageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadModule>()),
  imageUpload: (...a: unknown[]) => h.imageUpload(...a),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: () => h.buzzAccounts(),
  getUserBuzzAccount: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
// Same shim the sibling router suites use: cuts the Prisma-generated chain that
// `rateLimit` pulls in. Rate limiting through it is not under test here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { BLOCK_STEP_NAME } from '~/server/services/blocks/workflow.service';
import { TRAINING_WORKFLOW_TAG } from '~/server/services/orchestrator/training/workflow-state';
import { composeTrainingBlockExternalId } from '~/server/utils/block-gen-idempotency';
import {
  hashTrainingBody,
  TRAINING_RUN_GENERATION_TTL_SECONDS,
  trainingRunKey,
} from '~/server/services/blocks/block-training-quote.service';
import { blockTrainingBodySchema } from '~/server/schema/blocks/workflow.schema';

// ── An in-memory sysRedis: get/set (NX/XX/KEEPTTL/EX)/getDel/del/incrBy/decrBy. ──
const store = new Map<string, string>();
function installRedis() {
  const r = redisMock.sysRedis;
  r.get.mockImplementation(async (k: string) => store.get(k) ?? null);
  r.set.mockImplementation(async (k: string, v: string, opts?: { NX?: boolean; XX?: boolean }) => {
    if (opts?.NX && store.has(k)) return null;
    if (opts?.XX && !store.has(k)) return null;
    store.set(k, String(v));
    return 'OK';
  });
  r.getDel.mockImplementation(async (k: string) => {
    const v = store.get(k) ?? null;
    store.delete(k);
    return v;
  });
  r.del.mockImplementation(async (k: string) => (store.delete(k) ? 1 : 0));
  r.incrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) + n;
    store.set(k, String(v));
    return v;
  });
  r.decrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) - n;
    store.set(k, String(v));
    return v;
  });
  r.expire.mockImplementation(async () => true);
  r.ttl.mockImplementation(async () => 3600);
}
const keysWith = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix));
const counter = (prefix: string) =>
  keysWith(prefix).reduce((s, k) => s + Number(store.get(k) ?? 0), 0);

// ── Fixtures ────────────────────────────────────────────────────────────────
const VIEWER = 42;
// sha256 for app `apb_test`, the default `body()`, generation 0.
const RUN_KEY_LITERAL = '74961cae861fd55c80be3ab2c0f22ef6920cb2c608a91b9afe598fc3b0fbbeb0';
const DATASET_ID = `tds_${'d'.repeat(32)}`;

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'page_apb_test',
    ctx: { slotId: 'app.page', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    // FAR below every price in this file — the point of the arm.
    buzzBudget: 50,
    maxBrowsingLevel: 1,
    ...over,
  };
}

const PARAMS = {
  engine: 'ai-toolkit',
  ecosystem: 'sdxl',
  epochs: 5,
  resolution: 1024,
  lr: 0.0001,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'cosine',
  optimizerType: 'adamw8bit',
  networkDim: 32,
  networkAlpha: 16,
  noiseOffset: null,
  minSnrGamma: null,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};

function body(over: Record<string, unknown> = {}) {
  return {
    kind: 'training' as const,
    datasetId: DATASET_ID,
    engine: 'ai-toolkit' as const,
    model: 'sdxl',
    params: PARAMS,
    triggerWord: 'mychar',
    samplePrompts: ['mychar on a beach'],
    ...over,
  };
}

function seedDataset(over: Record<string, unknown> = {}) {
  store.set(
    `system:blocks:training-dataset:${DATASET_ID}`,
    JSON.stringify({
      v: 1,
      datasetId: DATASET_ID,
      userId: VIEWER,
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      items: [
        {
          imageId: 1,
          air: 'https://o.example/v2/consumer/blobs/k1.jpeg',
          caption: 'a',
          thumbnailUrl: 't1',
        },
        {
          imageId: 2,
          air: 'https://o.example/v2/consumer/blobs/k2.jpeg',
          caption: 'b',
          thumbnailUrl: 't2',
        },
      ],
      count: 2,
      createdAt: 'x',
      ...over,
    })
  );
}

/** A quote written straight to the store, for records the estimate would never write. */
function seedQuote(quoteId: string, over: Record<string, unknown> = {}) {
  store.set(
    `system:blocks:training-quote:${quoteId}`,
    JSON.stringify({
      v: 1,
      quoteId,
      userId: VIEWER,
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      total: 1200,
      bodyHash: hashTrainingBody(blockTrainingBodySchema.parse(body())),
      datasetId: DATASET_ID,
      imageCount: 2,
      modelKey: 'sdxl',
      modelName: 'SDXL',
      ecosystem: 'sdxl',
      epochs: 5,
      steps: null,
      expiresAt: 'x',
      consentedBy: VIEWER,
      consentedAt: 'x',
      ...over,
    })
  );
}

function imageRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    url: 'k',
    type: 'image',
    nsfwLevel: 1,
    ingestion: 'Scanned',
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    ...over,
  };
}

let whatifPrice: { total?: number; variable?: boolean } = { total: 1200 };
let chargedPrice = 1200;
let workflowId = `${VIEWER}-20261005`;
function installOrchestrator() {
  h.submitWorkflow.mockImplementation(
    async (args: { body: { steps: unknown[] }; query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) return { id: 'whatif-id', cost: { ...whatifPrice } };
      return {
        id: workflowId,
        status: 'scheduled',
        cost: { total: chargedPrice, base: chargedPrice },
        transactions: { list: [] },
        steps: args.body.steps,
      };
    }
  );
}
const realSubmits = () =>
  h.submitWorkflow.mock.calls.filter(
    (c) => !(c[0] as { query?: { whatif?: boolean } }).query?.whatif
  );
const whatifs = () =>
  h.submitWorkflow.mock.calls.filter(
    (c) => (c[0] as { query?: { whatif?: boolean } }).query?.whatif
  );

function ctx(sessionUserId?: number) {
  return {
    acceptableOrigin: true,
    // guardedProcedure: an onboarded, unmuted, email-verified session.
    user:
      sessionUserId == null
        ? undefined
        : { id: sessionUserId, isModerator: false, onboarding: 0xffff, muted: false },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}
const caller = (sessionUserId?: number) => blocksRouter.createCaller(ctx(sessionUserId) as never);

async function estimate(b = body()) {
  return caller().estimateWorkflow({ blockToken: 't', body: b as never });
}
async function consent(quoteId: string, sessionUserId = VIEWER) {
  return caller(sessionUserId).consentTrainingQuote({ blockToken: 't', quoteId });
}
async function submit(b: Record<string, unknown>) {
  return caller().submitWorkflow({ blockToken: 't', body: b as never });
}

beforeEach(() => {
  store.clear();
  for (const fn of Object.values(h)) fn.mockClear();
  installRedis();
  installOrchestrator();
  whatifPrice = { total: 1200 };
  chargedPrice = 1200;
  workflowId = `${VIEWER}-20261005`;
  h.authorize.mockImplementation(async () => claims());
  h.trainingFlag.mockImplementation(async () => true);
  h.features.mockImplementation(() => ({ aiToolkitSdxl: true, trainingStepsPricing: true }));
  h.trainingStatus.mockImplementation(async () => ({ available: true, blockedModels: [] }));
  h.reserveAppSpend.mockImplementation(async () => ({ allowed: true, dailyKey: 'app-daily' }));
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);
  dbMock.dbRead.$queryRaw.mockClear();
  // The dataset images, re-read on the PRIMARY before every quote and charge.
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([imageRow({ id: 1 }), imageRow({ id: 2 })]);
  h.getActiveDevTunnel.mockImplementation(async () => null);
  seedDataset();
});
afterEach(() => envMock.reset());

// ─────────────────────────────────────────────────────────────────────────────
describe('training ESTIMATE — prices the run and stores a quote', () => {
  it('returns the quote and stores it UNCONSENTED, reserving nothing', async () => {
    const { snapshot } = (await estimate()) as {
      snapshot: { cost: { total: number }; trainingQuote: { quoteId: string; total: number } };
    };
    expect(snapshot.cost.total).toBe(1200);
    expect(snapshot.trainingQuote.total).toBe(1200);
    expect(snapshot.trainingQuote.quoteId).toMatch(/^tq_[a-f0-9]{32}$/);
    const stored = JSON.parse(
      store.get(`system:blocks:training-quote:${snapshot.trainingQuote.quoteId}`) as string
    );
    expect(stored).toMatchObject({ userId: VIEWER, total: 1200, consentedBy: null, imageCount: 2 });
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
  });

  it('prices the step the submit will run: block-step name, no timeout, the stored blobs', async () => {
    await estimate();
    const req = whatifs()[0][0] as {
      body: { steps: Array<Record<string, unknown>>; tags: string[] };
    };
    const step = req.body.steps[0];
    expect(step.name).toBe(BLOCK_STEP_NAME);
    expect('timeout' in step).toBe(false);
    expect((step.input as { trainingData: unknown }).trainingData).toEqual({
      type: 'blobs',
      items: [
        { air: 'https://o.example/v2/consumer/blobs/k1.jpeg', caption: 'a' },
        { air: 'https://o.example/v2/consumer/blobs/k2.jpeg', caption: 'b' },
      ],
    });
    // The quote is priced under the SAME tags the submit uses.
    expect(req.body.tags).toEqual([
      'gen',
      'img',
      'training',
      'ai-toolkit',
      'app-block',
      'app-block:app_test',
      'app-block:block:blk_test',
      'app-block:instance:page_apb_test',
    ]);
  });

  it('audits the trigger word and sample prompts before pricing', async () => {
    await estimate();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'mychar\nmychar on a beach',
        userId: VIEWER,
        isGreen: true,
      })
    );
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(
      h.submitWorkflow.mock.invocationCallOrder[0]
    );
  });

  it.each([
    ['an absent price', {}],
    ['a zero price', { total: 0 }],
    ['a variable (cap) price', { total: 1200, variable: true }],
  ])('fails CLOSED on %s and stores no quote', async (_l, price) => {
    whatifPrice = price;
    await expect(estimate()).rejects.toThrow('training price could not be determined');
    expect(keysWith('system:blocks:training-quote')).toEqual([]);
  });

  it('refuses a price above the per-run limit and stores no quote', async () => {
    whatifPrice = { total: 5001 };
    await expect(estimate()).rejects.toThrow('above the per-run limit of 5000');
    expect(keysWith('system:blocks:training-quote')).toEqual([]);
  });
});

describe('training GATES — page tokens of an ordinary viewer only', () => {
  it.each([
    ['a dev token', claims({ dev: true }), 'development or review session'],
    [
      'a review run-for-real token',
      claims({ reviewRunForReal: true }),
      'development or review session',
    ],
    [
      'a model-slot token',
      claims({ ctx: { modelId: 7, slotId: 'model.sidebar_top' } }),
      'page-only',
    ],
    [
      'an editor private run',
      claims({ privateRun: true, privateRunAudience: 'editor' }),
      'block token missing budget',
    ],
    ['a token without the spend scope', claims({ scopes: [] }), 'ai:write:budgeted'],
  ])('refuses %s on estimate AND submit, before any orchestrator call', async (_l, c, msg) => {
    h.authorize.mockImplementation(async () => c);
    await expect(estimate()).rejects.toThrow(msg);
    seedQuote(`tq_${'1'.repeat(32)}`);
    await expect(submit(body({ quoteId: `tq_${'1'.repeat(32)}` }))).rejects.toThrow(msg);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses while the training-kind flag is off for the token subject', async () => {
    h.trainingFlag.mockImplementation(async () => false);
    await expect(estimate()).rejects.toThrow('training from apps is not enabled');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a dataset prepared for another viewer, app or install', async () => {
    seedDataset({ userId: 7 });
    await expect(estimate()).rejects.toThrow('training dataset not found or expired');
    seedDataset({ blockInstanceId: 'page_other' });
    await expect(estimate()).rejects.toThrow('training dataset not found or expired');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('training CONSENT — session-only, and only the quote’s own subject', () => {
  it('requires a signed-in session (the block, holding only its token, cannot call it)', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await expect(
      caller(undefined).consentTrainingQuote({
        blockToken: 't',
        quoteId: snapshot.trainingQuote.quoteId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a session that is not the token subject, and records nothing', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await expect(consent(snapshot.trainingQuote.quoteId, 7)).rejects.toThrow(
      'belongs to a different account'
    );
    const stored = JSON.parse(
      store.get(`system:blocks:training-quote:${snapshot.trainingQuote.quoteId}`) as string
    );
    expect(stored.consentedBy).toBeNull();
  });

  it('records the confirmation, and preview shows only server-resolved values', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    const quoteId = snapshot.trainingQuote.quoteId;
    const preview = await caller(VIEWER).previewTrainingQuote({ blockToken: 't', quoteId });
    expect(preview).toMatchObject({
      quoteId,
      total: 1200,
      imageCount: 2,
      modelName: 'SDXL',
      epochs: 5,
      thumbnails: ['t1', 't2'],
      // SFW token → blue + green are spendable: 100 + 200 = 300, short 900.
      shortfall: 900,
    });
    await expect(consent(quoteId)).resolves.toMatchObject({ consented: true, total: 1200 });
    const stored = JSON.parse(store.get(`system:blocks:training-quote:${quoteId}`) as string);
    expect(stored.consentedBy).toBe(VIEWER);
  });
});

describe('training SUBMIT — charged only against a confirmed, re-quoted, single-use quote', () => {
  async function confirmedQuote() {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await consent(snapshot.trainingQuote.quoteId);
    return snapshot.trainingQuote.quoteId;
  }

  it('a confirmed run ABOVE the per-call budget is submitted, with every cap reserved', async () => {
    const quoteId = await confirmedQuote();
    const { snapshot } = (await submit(body({ quoteId }))) as {
      snapshot: { workflowId: string; status: string };
    };
    expect(snapshot.workflowId).toBe(workflowId);
    expect(snapshot.status).not.toBe('failed');

    const real = realSubmits();
    expect(real).toHaveLength(1);
    const req = real[0][0] as {
      body: { steps: Array<Record<string, unknown>>; tags: string[]; externalId: string };
    };
    expect(req.body.steps[0].name).toBe(BLOCK_STEP_NAME);
    expect('timeout' in req.body.steps[0]).toBe(false);
    expect(req.body.steps[0].$type).toBe('training');
    // The WHOLE list, as literals: server constants only, the training tag exactly
    // once, and the app-scoping tag the subqueue read filters on.
    expect(TRAINING_WORKFLOW_TAG).toBe('training');
    expect(req.body.tags).toEqual([
      'gen',
      'img',
      'training',
      'ai-toolkit',
      'app-block',
      'app-block:app_test',
      'app-block:block:blk_test',
      'app-block:instance:page_apb_test',
    ]);
    expect(req.body.externalId).toBe(
      composeTrainingBlockExternalId(
        trainingRunKey('apb_test', blockTrainingBodySchema.parse(body({ quoteId })), 0)
      )
    );

    // Per-user daily cap and per-app aggregate both reserved at the re-quoted price.
    expect(counter('system:blocks:buzz-cap')).toBe(1200);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', 1200);
    expect(h.persistSettle).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId, ceiling: 1200, engine: 'training' })
    );
    // The quote is gone — single use.
    expect(keysWith('system:blocks:training-quote')).toEqual([]);
  });

  it('…while the SAME amount on the pass-through arm is still refused by the per-call budget', async () => {
    whatifPrice = { total: 1200 };
    const { snapshot } = (await submit({
      kind: 'step',
      $type: 'training',
      input: {},
      maxBuzz: 40,
    })) as { snapshot: { status: string; error: string } };
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('insufficient buzz budget');
    expect(realSubmits()).toHaveLength(0);
  });

  it('records attribution as training:<ecosystem> and charges NO author fee', async () => {
    const quoteId = await confirmedQuote();
    await submit(body({ quoteId }));
    await vi.waitFor(() => expect(h.recordSpendAttribution).toHaveBeenCalledTimes(1));
    expect(h.recordSpendAttribution).toHaveBeenCalledWith(
      expect.objectContaining({
        generationType: 'training:sdxl',
        workflowId,
        appBlockId: 'apb_test',
        privateRun: false,
      })
    );
    expect(h.chargeAuthorFee).not.toHaveBeenCalled();
  });

  it('refuses a submit naming no quote', async () => {
    await expect(submit(body())).rejects.toThrow('must name the confirmed quoteId');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an UNCONFIRMED quote — before any re-quote or reservation', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    h.submitWorkflow.mockClear();
    await expect(submit(body({ quoteId: snapshot.trainingQuote.quoteId }))).rejects.toThrow(
      'has not been confirmed by the viewer'
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });

  it('refuses a quote confirmed by ANOTHER user', async () => {
    const quoteId = `tq_${'2'.repeat(32)}`;
    seedQuote(quoteId, { consentedBy: 7 });
    await expect(submit(body({ quoteId }))).rejects.toThrow('has not been confirmed by the viewer');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an expired / unknown quote', async () => {
    await expect(submit(body({ quoteId: `tq_${'3'.repeat(32)}` }))).rejects.toThrow(
      'training quote not found, expired or already used'
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('a quote runs at most once: a repeat submit replays, with no second charge', async () => {
    const quoteId = await confirmedQuote();
    const first = await submit(body({ quoteId }));
    const second = await submit(body({ quoteId }));
    expect(second).toEqual(first);
    expect(realSubmits()).toHaveLength(1);
    expect(counter('system:blocks:buzz-cap')).toBe(1200);
  });

  it('refuses a body that differs from the quoted one — and the quote is spent', async () => {
    const quoteId = await confirmedQuote();
    await expect(submit(body({ quoteId, triggerWord: 'other' }))).rejects.toThrow(
      'differs from the one that was quoted'
    );
    await expect(submit(body({ quoteId }))).rejects.toThrow('already used');
    expect(realSubmits()).toHaveLength(0);
  });

  it('refuses when the re-quote rose above the confirmed price, reserving nothing', async () => {
    const quoteId = await confirmedQuote();
    whatifPrice = { total: 1201 };
    await expect(submit(body({ quoteId }))).rejects.toThrow('changed from 1200 to 1201');
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });

  it('refuses when the re-quote turned variable', async () => {
    const quoteId = await confirmedQuote();
    whatifPrice = { total: 1100, variable: true };
    await expect(submit(body({ quoteId }))).rejects.toThrow('could not be confirmed');
    expect(realSubmits()).toHaveLength(0);
  });

  it('a lower re-quote is charged at the re-quoted price', async () => {
    const quoteId = await confirmedQuote();
    whatifPrice = { total: 900 };
    await submit(body({ quoteId }));
    expect(counter('system:blocks:buzz-cap')).toBe(900);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', 900);
  });

  it('never charges above the per-run limit, even for a confirmed quote above it', async () => {
    // The estimate never stores such a quote; this is the ceiling's own half.
    const quoteId = `tq_${'4'.repeat(32)}`;
    seedQuote(quoteId, { total: 6000 });
    whatifPrice = { total: 5500 };
    await expect(submit(body({ quoteId }))).rejects.toThrow('exceeds the per-run limit 5000');
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });

  it('refunds every reservation when the orchestrator submit throws', async () => {
    const quoteId = await confirmedQuote();
    h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) return { cost: { total: 1200 } };
      throw new Error('orchestrator down');
    });
    await expect(submit(body({ quoteId }))).rejects.toThrow('orchestrator down');
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.refundAppSpend).toHaveBeenCalledWith('app-daily', 1200);
  });

  it('tears down and refunds a run the orchestrator attributed to someone else', async () => {
    envMock.set({ ORCHESTRATOR_MODE: 'prod' });
    const quoteId = await confirmedQuote();
    workflowId = '7-20261005';
    await expect(submit(body({ quoteId }))).rejects.toThrow('could not confirm who this');
    expect(h.deleteWorkflow).toHaveBeenCalledTimes(1);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.recordSpendAttribution).not.toHaveBeenCalled();
  });
});

describe('prepareTrainingDataset', () => {
  it('charges the image-weighted bucket by item count and returns a bound handle', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      {
        id: 5,
        url: 'k5',
        type: 'image',
        nsfwLevel: 1,
        ingestion: 'Scanned',
        needsReview: null,
        poi: false,
        minor: false,
        tosViolation: false,
        acceptableMinor: false,
        blockedFor: null,
      },
    ]);
    h.imageUpload.mockResolvedValue({
      blob: { available: true, url: 'https://o.example/v2/consumer/blobs/k5.jpeg?s=1' },
    });
    const out = await caller().prepareTrainingDataset({
      blockToken: 't',
      items: [
        { imageId: 5, caption: 'x' },
        { imageId: 6, caption: 'y' },
      ],
    });
    expect(h.datasetRate).toHaveBeenCalledWith('page_apb_test', VIEWER, 2);
    expect(out.count).toBe(1);
    expect(out.rejected).toEqual([{ imageId: 6, reason: 'unavailable' }]);
    expect(
      JSON.parse(store.get(`system:blocks:training-dataset:${out.datasetId}`) as string)
    ).toMatchObject({ userId: VIEWER, appBlockId: 'apb_test', blockInstanceId: 'page_apb_test' });
  });

  it('runs the training gates first: a dev token prepares nothing', async () => {
    h.authorize.mockImplementation(async () => claims({ dev: true }));
    await expect(
      caller().prepareTrainingDataset({ blockToken: 't', items: [{ imageId: 5, caption: '' }] })
    ).rejects.toThrow('development or review session');
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(h.imageUpload).not.toHaveBeenCalled();
  });
});

describe('training — maturity, currency and re-admission', () => {
  async function confirmedQuote() {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await consent(snapshot.trainingQuote.quoteId);
    return snapshot.trainingQuote.quoteId;
  }

  // Currencies are not asserted: the global `@civitai/client` mock leaves the
  // orchestrator account enum unmapped, so every currency reads `undefined` here.
  it('a SFW token prices and submits with mature output off', async () => {
    const quoteId = await confirmedQuote();
    await submit(body({ quoteId }));
    const calls = h.submitWorkflow.mock.calls.map(
      (c) => (c[0] as { body: { allowMatureContent?: boolean } }).body
    );
    expect(calls.length).toBe(3); // estimate whatif, submit re-quote, real submit
    for (const b of calls) expect(b.allowMatureContent).toBe(false);
  });

  it('control: an all-levels token does not send the SFW clamp', async () => {
    h.authorize.mockImplementation(async () => claims({ maxBrowsingLevel: 31 }));
    await estimate();
    const b = (whatifs()[0][0] as { body: { allowMatureContent?: boolean } }).body;
    expect('allowMatureContent' in b).toBe(false);
  });

  it('an image moderated after preparation blocks the estimate (re-read on the primary)', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      imageRow({ id: 1 }),
      imageRow({ id: 2, minor: true }),
    ]);
    await expect(estimate()).rejects.toThrow('can no longer be used for training');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('…and blocks the charge when it happens between consent and submit', async () => {
    const quoteId = await confirmedQuote();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([imageRow({ id: 1 })]); // image 2 gone
    await expect(submit(body({ quoteId }))).rejects.toThrow('can no longer be used for training');
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });

  it('a dataset that expired between estimate and submit is refused before any charge', async () => {
    const quoteId = await confirmedQuote();
    store.delete(`system:blocks:training-dataset:${DATASET_ID}`);
    await expect(submit(body({ quoteId }))).rejects.toThrow(
      'training dataset not found or expired'
    );
    expect(realSubmits()).toHaveLength(0);
  });

  it('the submit re-audits the body text, and a refusal charges nothing', async () => {
    const quoteId = await confirmedQuote();
    h.audit.mockRejectedValueOnce(new Error('prompt refused'));
    await expect(submit(body({ quoteId }))).rejects.toThrow('prompt refused');
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });

  it('a fractional whatif price is rounded UP, never down', async () => {
    whatifPrice = { total: 1199.2 };
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { total: number } } };
    expect(snapshot.trainingQuote.total).toBe(1200);
  });
});

describe('training — the reservation belt refunds and releases on every refusal', () => {
  async function confirmedQuote() {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await consent(snapshot.trainingQuote.quoteId);
    return snapshot.trainingQuote.quoteId;
  }
  const genIdemKeys = () => keysWith('system:blocks:gen-idem');

  it('per-user daily cap reached → failed snapshot, refunded, claim released', async () => {
    const quoteId = await confirmedQuote();
    const realIncr = redisMock.sysRedis.incrBy.getMockImplementation()!;
    redisMock.sysRedis.incrBy.mockImplementation(async (k: string, n: number) =>
      k.startsWith('system:blocks:buzz-cap') ? realIncr(k, n + 49_500) : realIncr(k, n)
    );
    const { snapshot } = (await submit(body({ quoteId }))) as {
      snapshot: { status: string; error: string };
    };
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('daily Buzz cap reached');
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(49_500); // the 1200 was refunded
    expect(genIdemKeys()).toEqual([]);
  });

  it('the viewer’s own per-app budget → failed snapshot, both legs refunded', async () => {
    const quoteId = await confirmedQuote();
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      buzzBudgetPerDay: 500,
      revokedAt: null,
    });
    const { snapshot } = (await submit(body({ quoteId }))) as {
      snapshot: { status: string; error: string };
    };
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toContain('your limit for this app is 500');
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(counter('system:blocks:consent-budget')).toBe(0);
    expect(genIdemKeys()).toEqual([]);
  });

  it('per-app aggregate refused → failed snapshot, user cap refunded', async () => {
    const quoteId = await confirmedQuote();
    h.reserveAppSpend.mockImplementation(async () => ({ allowed: false, reason: 'velocity' }));
    const { snapshot } = (await submit(body({ quoteId }))) as {
      snapshot: { status: string; error: string };
    };
    expect(snapshot.error).toContain('app generation rate limit reached');
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(genIdemKeys()).toEqual([]);
  });

  it('dev-session backstop refused → failed snapshot, user AND app reservations refunded', async () => {
    const quoteId = await confirmedQuote();
    h.getActiveDevTunnel.mockImplementation(async () => ({ sessionId: 's1', spendCapBuzz: 100 }));
    h.reserveDevSessionBuzz.mockImplementation(async () => ({ allowed: false, total: 90 }));
    const { snapshot } = (await submit(body({ quoteId }))) as {
      snapshot: { status: string; error: string };
    };
    expect(snapshot.error).toContain('dev tunnel session Buzz cap reached');
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.refundAppSpend).toHaveBeenCalledWith('app-daily', 1200);
    expect(genIdemKeys()).toEqual([]);
  });
});

describe('training — idempotency is keyed on the RUN, in a server-only namespace', () => {
  it('a retry after an ambiguous failure presents the SAME orchestrator externalId', async () => {
    const run = async () => {
      const { snapshot } = (await estimate()) as {
        snapshot: { trainingQuote: { quoteId: string } };
      };
      await consent(snapshot.trainingQuote.quoteId);
      return snapshot.trainingQuote.quoteId;
    };
    h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) return { cost: { total: 1200 } };
      throw new Error('socket hang up');
    });
    const q1 = await run();
    await expect(submit(body({ quoteId: q1 }))).rejects.toThrow('socket hang up');
    const q2 = await run();
    expect(q2).not.toBe(q1);
    await expect(submit(body({ quoteId: q2 }))).rejects.toThrow('socket hang up');
    const ids = realSubmits().map(
      (c) => (c[0] as { body: { externalId: string } }).body.externalId
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^blt[a-f0-9]{64}$/);
  });

  it('a client idempotency key equal to the quote id cannot occupy the run’s claim', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    const quoteId = snapshot.trainingQuote.quoteId;
    // What a block could plant: a gen-idem entry under the quote id as its own key.
    store.set(
      `system:blocks:gen-idem:${VIEWER}:apb_test:${quoteId}`,
      JSON.stringify({ result: 'x' })
    );
    await consent(quoteId);
    const out = (await submit(body({ quoteId }))) as { snapshot: { workflowId: string } };
    expect(out.snapshot.workflowId).toBe(workflowId);
    expect(realSubmits()).toHaveLength(1);
  });
});

describe('training — consent and preview edges', () => {
  it('a claim landing BETWEEN consent’s read and write does not resurrect the quote', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    const quoteId = snapshot.trainingQuote.quoteId;
    const key = `system:blocks:training-quote:${quoteId}`;
    const realGet = redisMock.sysRedis.get.getMockImplementation()!;
    let raced = false;
    redisMock.sysRedis.get.mockImplementation(async (k: string) => {
      const v = await realGet(k);
      if (k === key && !raced) {
        raced = true;
        store.delete(key); // a submit's GETDEL wins the race here
      }
      return v;
    });
    await expect(consent(quoteId)).rejects.toThrow('training quote not found or expired');
    expect(raced).toBe(true);
    expect(store.has(key)).toBe(false);
  });

  it('a quote already claimed by a submit cannot be confirmed again, and nothing is written', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    const quoteId = snapshot.trainingQuote.quoteId;
    await consent(quoteId);
    await submit(body({ quoteId }));
    await expect(consent(quoteId)).rejects.toThrow('training quote not found or expired');
    expect(keysWith('system:blocks:training-quote')).toEqual([]);
  });

  it('preview refuses a session that is not the token subject', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await expect(
      caller(7).previewTrainingQuote({ blockToken: 't', quoteId: snapshot.trainingQuote.quoteId })
    ).rejects.toThrow('belongs to a different account');
  });

  it('consent refuses a muted viewer (guarded procedure)', async () => {
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    const muted = blocksRouter.createCaller({
      ...ctx(VIEWER),
      user: { id: VIEWER, isModerator: false, onboarding: 0xffff, muted: true },
    } as never);
    await expect(
      muted.consentTrainingQuote({ blockToken: 't', quoteId: snapshot.trainingQuote.quoteId })
    ).rejects.toThrow('restricted');
  });
});

describe('prepareTrainingDataset — router wiring', () => {
  it('audits the captions as the token subject, clamps the import, and applies the token ceiling', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      imageRow({ id: 5, url: 'k5' }),
      imageRow({ id: 6, url: 'k6', nsfwLevel: 4 }), // R, above this PG token
    ]);
    h.imageUpload.mockResolvedValue({
      blob: { available: true, url: 'https://o.example/v2/consumer/blobs/k5.jpeg' },
    });
    const out = await caller().prepareTrainingDataset({
      blockToken: 't',
      items: [
        { imageId: 5, caption: 'a cat' },
        { imageId: 6, caption: 'a dog' },
      ],
    });
    expect(out.rejected).toEqual([{ imageId: 6, reason: 'not-eligible' }]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a cat', userId: VIEWER, isGreen: true })
    );
    expect(h.imageUpload).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'orch-token', allowMatureContent: false })
    );
  });

  it('charges its own per-(install, viewer) bucket by image count', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([imageRow({ id: 5 })]);
    h.imageUpload.mockResolvedValue({
      blob: { available: true, url: 'https://o.example/v2/consumer/blobs/k5.jpeg' },
    });
    await caller().prepareTrainingDataset({
      blockToken: 't',
      items: [
        { imageId: 5, caption: '' },
        { imageId: 7, caption: '' },
        { imageId: 8, caption: '' },
      ],
    });
    expect(h.datasetRate).toHaveBeenCalledWith('page_apb_test', VIEWER, 3);
    expect(h.publishRate).not.toHaveBeenCalled();
  });
});

describe('training — the run key', () => {
  async function confirmed(b = body()) {
    const { snapshot } = (await estimate(b)) as {
      snapshot: { trainingQuote: { quoteId: string } };
    };
    await consent(snapshot.trainingQuote.quoteId);
    return snapshot.trainingQuote.quoteId;
  }
  const externalIds = () =>
    realSubmits().map((c) => (c[0] as { body: { externalId: string } }).body.externalId);

  it('is pinned to a literal for a fixed run, so its derivation cannot drift silently', () => {
    expect(trainingRunKey('apb_test', blockTrainingBodySchema.parse(body()), 0)).toBe(
      RUN_KEY_LITERAL
    );
  });

  it('two DIFFERENT runs by the same viewer are two orchestrator runs', async () => {
    // The first submit fails ambiguously, so the run generation does NOT move —
    // only the body differs between the two ids.
    h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) return { cost: { total: 1200 } };
      throw new Error('socket hang up');
    });
    const q1 = await confirmed();
    await expect(submit(body({ quoteId: q1 }))).rejects.toThrow('socket hang up');
    const q2 = await confirmed(body({ triggerWord: 'otherchar' }));
    await expect(submit(body({ quoteId: q2, triggerWord: 'otherchar' }))).rejects.toThrow(
      'socket hang up'
    );
    expect(realSubmits()).toHaveLength(2);
    expect(new Set(externalIds()).size).toBe(2);
  });

  it('a deliberate RE-RUN after a definite submit is a new orchestrator run', async () => {
    const q1 = await confirmed();
    await submit(body({ quoteId: q1 }));
    const q2 = await confirmed();
    await submit(body({ quoteId: q2 }));
    expect(realSubmits()).toHaveLength(2);
    expect(new Set(externalIds()).size).toBe(2);
  });

  it('a lost-response retry of the SAME submit replays, with no second charge', async () => {
    const q = await confirmed();
    const first = await submit(body({ quoteId: q }));
    expect(await submit(body({ quoteId: q }))).toEqual(first);
    expect(realSubmits()).toHaveLength(1);
  });
});

describe('training — remaining controls', () => {
  it('re-admission applies the token ceiling: an image re-rated above it blocks the run', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      imageRow({ id: 1 }),
      imageRow({ id: 2, nsfwLevel: 4 }),
    ]);
    await expect(estimate()).rejects.toThrow('can no longer be used for training');
  });

  it('the audit strictness follows the token: an all-levels token audits non-green', async () => {
    h.authorize.mockImplementation(async () => claims({ maxBrowsingLevel: 31 }));
    await estimate();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ isGreen: false }));
  });

  it('positive control: a viewer budget that fits is RESERVED on the consent leg', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      buzzBudgetPerDay: 5000,
      revokedAt: null,
    });
    const { snapshot } = (await estimate()) as { snapshot: { trainingQuote: { quoteId: string } } };
    await consent(snapshot.trainingQuote.quoteId);
    await submit(body({ quoteId: snapshot.trainingQuote.quoteId }));
    expect(counter('system:blocks:consent-budget')).toBe(1200);
  });
});

describe('training — the run generation is per BODY', () => {
  async function confirmed(b = body()) {
    const { snapshot } = (await estimate(b)) as {
      snapshot: { trainingQuote: { quoteId: string } };
    };
    await consent(snapshot.trainingQuote.quoteId);
    return snapshot.trainingQuote.quoteId;
  }
  const externalIds = () =>
    realSubmits().map((c) => (c[0] as { body: { externalId: string } }).body.externalId);

  it('a definite submit of ANOTHER body does not change a pending retry’s orchestrator id', async () => {
    let fail = true;
    h.submitWorkflow.mockImplementation(
      async (args: { body: { steps: unknown[] }; query?: { whatif?: boolean } }) => {
        if (args.query?.whatif) return { cost: { total: 1200 } };
        if (fail) throw new Error('socket hang up');
        return {
          id: workflowId,
          status: 'scheduled',
          cost: { total: 1200, base: 1200 },
          transactions: { list: [] },
          steps: args.body.steps,
        };
      }
    );
    const qa = await confirmed();
    await expect(submit(body({ quoteId: qa }))).rejects.toThrow('socket hang up');
    fail = false;
    const qb = await confirmed(body({ triggerWord: 'otherchar' }));
    await submit(body({ quoteId: qb, triggerWord: 'otherchar' }));
    const qa2 = await confirmed();
    await submit(body({ quoteId: qa2 }));
    expect(externalIds()).toHaveLength(3);
    const [a1, b1, a2] = externalIds();
    expect(a2).toBe(a1);
    expect(b1).not.toBe(a1);
  });

  it('a lost generation bump never breaks a paid submit, and the bump carries a TTL', async () => {
    const q = await confirmed();
    const realIncr = redisMock.sysRedis.incrBy.getMockImplementation()!;
    redisMock.sysRedis.incrBy.mockImplementation(async (k: string, n: number) => {
      if (k.includes(':runs:')) throw new Error('redis down');
      return realIncr(k, n);
    });
    const out = (await submit(body({ quoteId: q }))) as { snapshot: { workflowId: string } };
    expect(out.snapshot.workflowId).toBe(workflowId);
    expect(h.persistSettle).toHaveBeenCalled();

    redisMock.sysRedis.incrBy.mockImplementation(realIncr);
    redisMock.sysRedis.expire.mockClear();
    const q2 = await confirmed(body({ triggerWord: 'x2' }));
    await submit(body({ quoteId: q2, triggerWord: 'x2' }));
    const runsExpire = redisMock.sysRedis.expire.mock.calls.find((c) =>
      String(c[0]).includes(':runs:')
    );
    expect(runsExpire?.[1]).toBe(TRAINING_RUN_GENERATION_TTL_SECONDS);
    expect(TRAINING_RUN_GENERATION_TTL_SECONDS).toBe(172_800);
  });
});
