import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { annotateOrchestratorSubmitFailure } from '~/server/services/orchestrator/submit-failure';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as AttributionModule from '~/server/services/blocks/buzz-attribution.service';
import type * as AuthorFeeChargeModule from '~/server/services/blocks/author-fee-charge.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as MetricsModule from '~/server/metrics/app-block-runtime.metrics';

/**
 * The CONFIRMED pass-through step end-to-end through `blocksRouter`: estimate (grant)
 * → session-only preview + consent → submit. The quote store and the cap reservation
 * helpers run FOR REAL over an in-memory Redis; only the orchestrator, identity and
 * flag edges are stubbed. Modelled on `blocks.router.trainingKind.test.ts`.
 *
 * The property under test is the one the path exists for: ONE pass-through job whose
 * FIXED price exceeds the token's per-call budget may run ONLY against a quote its own
 * subject confirmed through a signed-in session, re-quoted at submit, single-use,
 * never above 5000 and never past the viewer's own daily limit — while every other cap
 * still applies. Every refusal is asserted against its OWN error.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertEnabled: vi.fn(async () => undefined),
  confirmedStepFlag: vi.fn(async () => true),
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
  submitWorkflow: vi.fn(),
  getUserById: vi.fn(async (): Promise<unknown> => ({ id: 42, isModerator: false })),
  overcharge: vi.fn(),
  reserveAppSpend: vi.fn(async () => ({ allowed: true, dailyKey: 'app-daily' })),
  refundAppSpend: vi.fn(async () => undefined),
  persistSettle: vi.fn(async () => undefined),
  recordSpendAttribution: vi.fn(async () => undefined),
  chargeAuthorFee: vi.fn(),
  recordScopeInvocation: vi.fn(async () => undefined),
  catalogRate: vi.fn(async () => ({ allowed: true })),
  buzzAccounts: vi.fn(async (): Promise<Record<string, number>> => ENOUGH_BUZZ),
  getActiveDevTunnel: vi.fn(async (): Promise<unknown> => null),
  reserveDevSessionBuzz: vi.fn(),
  refundDevSessionBuzz: vi.fn(async () => undefined),
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
  isAppBlocksConfirmedStepEnabled: (...a: unknown[]) => h.confirmedStepFlag(...(a as [])),
}));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricsModule>()),
  recordConfirmedQuoteOvercharge: (...a: unknown[]) => h.overcharge(...a),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: () => h.getOrchestratorToken(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  deleteWorkflow: vi.fn(),
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
  refundDevSessionBuzz: (...a: unknown[]) => h.refundDevSessionBuzz(...(a as [])),
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
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogRate(...(a as [])),
  checkBlockEstimateCellsRateLimit: async () => ({ allowed: true }),
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
import { composeConfirmedStepBlockExternalId } from '~/server/utils/block-gen-idempotency';
import { hashPassThroughStepBody } from '~/server/services/blocks/block-quote-grant.service';
import { blockPassThroughStepBodySchema } from '~/server/schema/blocks/workflow.schema';
import { GENERATION_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/generation-input-urls';

// ── An in-memory sysRedis: get/set (NX/XX)/getDel/del/incrBy/decrBy. ──────────
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
const ENOUGH_BUZZ = { blue: 100, green: 20_000, yellow: 0 };
const keysWith = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix));
const counter = (prefix: string) =>
  keysWith(prefix).reduce((s, k) => s + Number(store.get(k) ?? 0), 0);
const QUOTE_PREFIX = 'system:blocks:step-quote:sq_';

// ── Fixtures ────────────────────────────────────────────────────────────────
const VIEWER = 42;
// The production install cap: every price below is ABOVE it.
const BUDGET = 1000;
// The motivating case — a 3D generation the orchestrator quotes at ~1040 Buzz.
const PRICE = 1040;

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
    buzzBudget: BUDGET,
    maxBrowsingLevel: 1,
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    kind: 'step' as const,
    $type: 'polyGen',
    input: { engine: 'meshy', prompt: 'a teapot' },
    maxBuzz: 200,
    ...over,
  };
}
const BODY_HASH = () => hashPassThroughStepBody(blockPassThroughStepBodySchema.parse(body()));

/** A quote written straight to the store, for records the estimate would never write. */
function seedQuote(quoteId: string, over: Record<string, unknown> = {}) {
  store.set(
    `system:blocks:step-quote:${quoteId}`,
    JSON.stringify({
      v: 1,
      quoteId,
      userId: VIEWER,
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      total: PRICE,
      bodyHash: BODY_HASH(),
      stepType: 'polyGen',
      expiresAt: 'x',
      consentedBy: VIEWER,
      consentedAt: 'x',
      ...over,
    })
  );
}
const SEEDED = `sq_${'1'.repeat(32)}`;

let whatifPrice: { total?: number; variable?: boolean } = { total: PRICE };
let chargedPrice = PRICE;
let workflowId = `${VIEWER}-20261012`;
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

type EstimateReply = {
  snapshot: {
    cost: { total: number };
    stepQuote?: { quoteId: string; total: number; stepType: string; expiresAt: string };
  };
};
async function estimate(b: Record<string, unknown> = body()) {
  return (await caller().estimateWorkflow({ blockToken: 't', body: b as never })) as EstimateReply;
}
async function consent(quoteId: string, sessionUserId = VIEWER) {
  return caller(sessionUserId).consentQuoteGrant({ kind: 'step', blockToken: 't', quoteId });
}
type SubmitReply = {
  submissionUnconfirmed?: true;
  snapshot: { workflowId: string; status: string; error?: string; errorCode?: string };
};
async function submit(b: Record<string, unknown>) {
  return (await caller().submitWorkflow({ blockToken: 't', body: b as never })) as SubmitReply;
}
async function confirmedQuote() {
  const { snapshot } = await estimate();
  const quoteId = snapshot.stepQuote!.quoteId;
  await consent(quoteId);
  return quoteId;
}
function setDailyLimit(limit: number) {
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
    buzzBudgetPerDay: limit,
    revokedAt: null,
  });
}

beforeEach(() => {
  store.clear();
  for (const fn of Object.values(h)) fn.mockClear();
  loggingMock.logToAxiom.mockClear();
  installRedis();
  installOrchestrator();
  whatifPrice = { total: PRICE };
  chargedPrice = PRICE;
  workflowId = `${VIEWER}-20261012`;
  h.getUserById.mockImplementation(async () => ({ id: VIEWER, isModerator: false }));
  h.authorize.mockImplementation(async () => claims());
  h.confirmedStepFlag.mockImplementation(async () => true);
  h.reserveAppSpend.mockImplementation(async () => ({ allowed: true, dailyKey: 'app-daily' }));
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);
  h.getActiveDevTunnel.mockImplementation(async () => null);
  h.reserveDevSessionBuzz.mockReset();
  h.buzzAccounts.mockImplementation(async () => ENOUGH_BUZZ);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REGRESSION — a ~1040 fixed-price pass-through step above the 1000 budget', () => {
  it('is refused WITHOUT a confirmed grant (the per-call budget still binds)…', async () => {
    const r = await submit(body());
    expect(r.snapshot.status).toBe('failed');
    expect(r.snapshot.error).toBe(
      `insufficient buzz budget: step ceiling ${PRICE} exceeds budget ${BUDGET}`
    );
    expect(realSubmits()).toHaveLength(0);
  });

  it('…and RUNS with one, every cap reserved at the confirmed price', async () => {
    const quoteId = await confirmedQuote();
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.workflowId).toBe(workflowId);
    expect(r.snapshot.status).not.toBe('failed');

    const real = realSubmits();
    expect(real).toHaveLength(1);
    const req = real[0][0] as {
      body: { steps: Array<Record<string, unknown>>; externalId: string };
    };
    const step = req.body.steps[0];
    expect(step.$type).toBe('polyGen');
    expect(step.name).toBe(BLOCK_STEP_NAME);
    // Bounded by its confirmed price, never by the app's declared `maxBuzz`.
    expect('timeout' in step).toBe(false);
    expect(step.input).toEqual({ engine: 'meshy', prompt: 'a teapot' });
    // Keyed on the consumed QUOTE: `blc` + the quote id's own 32 hex chars. A literal
    // shape, not a re-derivation through the composer.
    expect(req.body.externalId).toBe(`blc${quoteId.slice(3)}`);
    expect(req.body.externalId).toMatch(/^blc[a-f0-9]{32}$/);
    expect(composeConfirmedStepBlockExternalId(quoteId)).toBe(req.body.externalId);

    expect(counter('system:blocks:buzz-cap')).toBe(PRICE);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', PRICE);
    expect(h.persistSettle).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId, ceiling: PRICE, engine: 'passthrough' })
    );
    // Single use: the quote is gone. There is no run counter for this kind.
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
    expect(keysWith('system:blocks:step-quote')).toEqual([]);
  });

  it('records attribution as step:<$type> and charges NO author fee', async () => {
    const quoteId = await confirmedQuote();
    await submit(body({ quoteId }));
    await vi.waitFor(() => expect(h.recordSpendAttribution).toHaveBeenCalledTimes(1));
    expect(h.recordSpendAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ generationType: 'step:polyGen', workflowId, privateRun: false })
    );
    expect(h.chargeAuthorFee).not.toHaveBeenCalled();
  });
});

describe('ESTIMATE — grants a confirmable quote only for a fixed price above the budget', () => {
  it('returns the quote and stores it UNCONSENTED, reserving nothing', async () => {
    const { snapshot } = await estimate();
    expect(snapshot.cost.total).toBe(PRICE);
    expect(snapshot.stepQuote).toMatchObject({ total: PRICE, stepType: 'polyGen' });
    expect(snapshot.stepQuote!.quoteId).toMatch(/^sq_[a-f0-9]{32}$/);
    const stored = JSON.parse(
      store.get(`system:blocks:step-quote:${snapshot.stepQuote!.quoteId}`) as string
    );
    expect(stored).toMatchObject({ userId: VIEWER, total: PRICE, consentedBy: null });
    expect(stored.bodyHash).toBe(BODY_HASH());
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });

  it('below or AT the per-call budget, the estimate is unchanged: no quote', async () => {
    for (const total of [800, BUDGET]) {
      whatifPrice = { total };
      const { snapshot } = await estimate();
      expect(snapshot).toEqual({
        workflowId: 'wf_estimate',
        status: 'pending',
        cost: { total },
      });
    }
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
  });

  it.each([
    ['an absent price', {}],
    ['a zero price', { total: 0 }],
    ['a negative price', { total: -5 }],
    ['a variable (metered) price', { total: PRICE, variable: true }],
    ['a price above the per-job limit of 5000', { total: 5001 }],
  ])('grants nothing for %s', async (_l, price) => {
    whatifPrice = price;
    const { snapshot } = await estimate();
    expect(snapshot.stepQuote).toBeUndefined();
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
  });

  it('grants exactly at the per-job limit', async () => {
    whatifPrice = { total: 5000 };
    expect((await estimate()).snapshot.stepQuote?.total).toBe(5000);
  });

  // The per-job limit equals the per-call cap (both 5000), so a token at the cap has
  // no price that is both above its budget and within the limit.
  it.each([[1040], [4999], [5000], [5001], [6301]])(
    'a token at the 5000 per-call cap is never offered a confirm (price %i) [INV]',
    async (total) => {
      h.authorize.mockImplementation(async () => claims({ buzzBudget: 5000 }));
      whatifPrice = { total };
      const { snapshot } = await estimate();
      expect(snapshot.cost.total).toBe(total);
      expect(snapshot.stepQuote).toBeUndefined();
      expect(keysWith(QUOTE_PREFIX)).toEqual([]);
    }
  );

  it('one Buzz under the cap, the top price is still confirmable [INV]', async () => {
    h.authorize.mockImplementation(async () => claims({ buzzBudget: 4999 }));
    whatifPrice = { total: 5000 };
    expect((await estimate()).snapshot.stepQuote?.total).toBe(5000);
  });

  it.each([
    ['the flag is off', claims(), false],
    ['a dev token', claims({ dev: true }), true],
    ['a review run-for-real token', claims({ reviewRunForReal: true }), true],
    ['an editor private run', claims({ privateRun: true, privateRunAudience: 'editor' }), true],
  ])('grants nothing when %s (and the estimate still answers)', async (_l, c, flag) => {
    h.authorize.mockImplementation(async () => c);
    h.confirmedStepFlag.mockImplementation(async () => flag);
    const { snapshot } = await estimate();
    expect(snapshot.cost.total).toBe(PRICE);
    expect(snapshot.stepQuote).toBeUndefined();
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
  });
});

describe("a TRAINING step type is never a confirmed step — use kind:'training'", () => {
  const TRAINING_TYPE_ERROR =
    "a training step type cannot run as a confirmed step — use kind:'training'";

  it.each(['training', 'imageResourceTraining'])(
    'the estimate refuses to grant a quote for $type "%s", and stores nothing',
    async ($type) => {
      whatifPrice = { total: 4000 };
      await expect(estimate(body({ $type }))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: TRAINING_TYPE_ERROR,
      });
      expect(keysWith(QUOTE_PREFIX)).toEqual([]);
    }
  );

  it.each(['training', 'imageResourceTraining'])(
    'a submit naming a confirmed step quote for $type "%s" is refused before the quote is touched',
    async ($type) => {
      whatifPrice = { total: 4000 };
      // A record the estimate would never write: bound, confirmed, and hashed for THIS body.
      seedQuote(SEEDED, {
        total: 4000,
        stepType: $type,
        bodyHash: hashPassThroughStepBody(blockPassThroughStepBodySchema.parse(body({ $type }))),
      });
      await expect(submit(body({ $type, quoteId: SEEDED }))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: TRAINING_TYPE_ERROR,
      });
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(keysWith(QUOTE_PREFIX)).toHaveLength(1);
    }
  );

  // Step types are matched case-insensitively, consistent with the denylist.
  const CASED = [
    'Training',
    'TRAINING',
    'IMAGERESOURCETRAINING',
    'imageresourcetraining',
    'ImageResourceTraining',
  ];

  it.each(CASED)('the estimate refuses $type "%s" whatever its case', async ($type) => {
    whatifPrice = { total: 4000 };
    await expect(estimate(body({ $type }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: TRAINING_TYPE_ERROR,
    });
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
  });

  it.each(CASED)(
    'a confirmed submit for $type "%s" is refused whatever its case',
    async ($type) => {
      whatifPrice = { total: 4000 };
      seedQuote(SEEDED, {
        total: 4000,
        stepType: $type,
        bodyHash: hashPassThroughStepBody(blockPassThroughStepBodySchema.parse(body({ $type }))),
      });
      await expect(submit(body({ $type, quoteId: SEEDED }))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: TRAINING_TYPE_ERROR,
      });
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(keysWith(QUOTE_PREFIX)).toHaveLength(1);
    }
  );

  it('control: a type that merely CONTAINS a training name is not refused', async () => {
    whatifPrice = { total: 4000 };
    expect((await estimate(body({ $type: 'trainingPreview' }))).snapshot.stepQuote?.total).toBe(
      4000
    );
  });

  it('control: with the flag off the training-type estimate is exactly what it was', async () => {
    h.confirmedStepFlag.mockImplementation(async () => false);
    whatifPrice = { total: 4000 };
    const { snapshot } = await estimate(body({ $type: 'training' }));
    expect(snapshot).toEqual({
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: 4000 },
    });
  });
});

describe('caller-supplied step types are matched case-insensitively everywhere', () => {
  // The ORDINARY (unconfirmed) pass-through arm, within the per-call budget.
  const cheap = (over: Record<string, unknown> = {}) => body({ maxBuzz: 200, ...over });

  it.each(['Training', 'TRAINING', 'ImageResourceTraining', 'imageresourcetraining'])(
    'an unquoted training step spelled "%s" is refused, as the exact spelling is',
    async ($type) => {
      h.submitWorkflow.mockImplementation(async () => {
        throw new Error('orchestrator down');
      });
      const r = await submit(cheap({ $type }));
      expect(r.snapshot).toMatchObject({
        workflowId: 'failed',
        status: 'failed',
        error: 'Training needs a price quote and none could be obtained; try again.',
        errorCode: 'training-quote-unavailable',
      });
      // Only the price check reached the orchestrator — nothing was submitted for real.
      expect(realSubmits()).toHaveLength(0);
    }
  );

  it('control: an unquoted NON-training step is not refused that way', async () => {
    h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) throw new Error('orchestrator down');
      return { id: workflowId, status: 'scheduled', cost: { total: 200 }, steps: [] };
    });
    const r = await submit(cheap({ $type: 'polyGen' }));
    expect(r.snapshot.errorCode).toBeUndefined();
    expect(realSubmits()).toHaveLength(1);
  });

  it.each(['training', 'Training', 'IMAGERESOURCETRAINING'])(
    'a training step spelled "%s" carries the training workflow tag',
    async ($type) => {
      whatifPrice = { total: 150 };
      await submit(cheap({ $type }));
      const tags = (realSubmits()[0][0] as { body: { tags: string[] } }).body.tags;
      expect(tags).toContain('training');
    }
  );

  it('control: a non-training step does not', async () => {
    whatifPrice = { total: 150 };
    await submit(cheap({ $type: 'polyGen' }));
    const tags = (realSubmits()[0][0] as { body: { tags: string[] } }).body.tags;
    expect(tags).not.toContain('training');
  });
});

describe('a BATCH estimate never stores a quote', () => {
  it('over-budget fixed-price cells store 0 records and carry no stepQuote', async () => {
    const out = await caller().estimateWorkflowBatch({
      blockToken: 't',
      bodies: [body(), body({ input: { engine: 'meshy', prompt: 'a cup' } })] as never,
    });
    expect(out.snapshots).toHaveLength(2);
    for (const snapshot of out.snapshots) {
      expect(snapshot.cost?.total).toBe(PRICE);
      expect('stepQuote' in snapshot).toBe(false);
    }
    expect(keysWith('system:blocks:step-quote')).toEqual([]);
    // The flag is never even evaluated for a batch cell.
    expect(h.confirmedStepFlag).not.toHaveBeenCalled();
  });

  it('positive control: the SAME body estimated on its own stores exactly one', async () => {
    const { snapshot } = await estimate();
    expect(snapshot.stepQuote?.total).toBe(PRICE);
    expect(keysWith(QUOTE_PREFIX)).toHaveLength(1);
  });
});

describe('the quote binds the EXACT body — non-JSON input is refused, not hashed loosely', () => {
  // One fixture per type, each different from the others, with the path it sits at.
  // (A BigInt is not here: the wire schema's own size check serialises `input` and
  // throws on one before any quote code runs. The hash's refusal of it is pinned in
  // `block-quote-grant.service.test.ts`.)
  const NON_JSON: Array<[string, Record<string, unknown>, string]> = [
    ['a Date', { engine: 'meshy', when: new Date(1) }, 'body.input.when is a Date'],
    ['a Map', { engine: 'meshy', m: new Map([['a', 1]]) }, 'body.input.m is a Map'],
    ['a Set', { engine: 'meshy', s: new Set([2]) }, 'body.input.s is a Set'],
    ['NaN', { engine: 'meshy', n: Number.NaN }, 'body.input.n is the non-finite number NaN'],
    [
      'an undefined array element',
      { engine: 'meshy', list: [4, undefined] },
      'body.input.list[1] is undefined',
    ],
    [
      'a sparse array (an empty slot)',
      // eslint-disable-next-line no-sparse-arrays
      { engine: 'meshy', sparse: [6, , 7] },
      'body.input.sparse[1] is an empty array slot',
    ],
    [
      'a nested class instance',
      { engine: 'meshy', deep: { url: new URL('https://example.com/5') } },
      'body.input.deep.url is a URL',
    ],
  ];
  const PREFIX =
    'a confirmed step needs plain JSON input (objects, arrays, strings, finite numbers, booleans, null) — ';

  it.each(NON_JSON)('the estimate refuses to grant a quote for %s', async (_l, input, where) => {
    await expect(estimate(body({ input }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `${PREFIX}${where}`,
    });
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
  });

  it.each(NON_JSON)(
    'a confirmed submit whose body carries %s is refused',
    async (_l, input, where) => {
      // A confirmed quote for the plain body; the submit swaps in the non-JSON input.
      const quoteId = await confirmedQuote();
      await expect(submit(body({ quoteId, input }))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `${PREFIX}${where}`,
      });
      expect(realSubmits()).toHaveLength(0);
      expect(counter('system:blocks:buzz-cap')).toBe(0);
    }
  );

  it('🔴 two bodies differing ONLY in a Date can no longer share a quote', async () => {
    // The probe that used to pass: quote `{when: Date(1)}`, submit `{when: Date(2)}`.
    // Neither is quotable now, so there is no quote for the second to ride on.
    await expect(estimate(body({ input: { engine: 'meshy', when: new Date(1) } }))).rejects.toThrow(
      'body.input.when is a Date'
    );
    seedQuote(SEEDED);
    await expect(
      submit(body({ quoteId: SEEDED, input: { engine: 'meshy', when: new Date(2) } }))
    ).rejects.toThrow('body.input.when is a Date');
    expect(realSubmits()).toHaveLength(0);
  });

  it('control: deeply nested PLAIN JSON is quotable and binds — a changed leaf is a different body', async () => {
    const input = { engine: 'meshy', opts: { tags: ['a', 'b'], n: 1.5, on: true, none: null } };
    const { snapshot } = await estimate(body({ input }));
    const quoteId = snapshot.stepQuote!.quoteId;
    await consent(quoteId);
    await expect(
      submit(body({ quoteId, input: { ...input, opts: { ...input.opts, tags: ['a', 'c'] } } }))
    ).rejects.toThrow('differs from the one that was quoted');
  });
});

describe('the preview’s daily-limit read, per kind', () => {
  it('a STEP preview FAILS when the limit cannot be read (never shown as "no limit")', async () => {
    const { snapshot } = await estimate();
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockRejectedValue(new Error('db unavailable'));
    await expect(
      caller(VIEWER).previewQuoteGrant({
        kind: 'step',
        blockToken: 't',
        quoteId: snapshot.stepQuote!.quoteId,
      })
    ).rejects.toThrow();
  });
});

describe('CONSENT — session-only, and only the quote’s own subject', () => {
  it('requires a signed-in session (the block, holding only its token, cannot call it)', async () => {
    const { snapshot } = await estimate();
    await expect(
      caller(undefined).consentQuoteGrant({
        kind: 'step',
        blockToken: 't',
        quoteId: snapshot.stepQuote!.quoteId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller(undefined).previewQuoteGrant({
        kind: 'step',
        blockToken: 't',
        quoteId: snapshot.stepQuote!.quoteId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a session that is not the token subject, and records nothing', async () => {
    const { snapshot } = await estimate();
    const quoteId = snapshot.stepQuote!.quoteId;
    await expect(consent(quoteId, 7)).rejects.toThrow('belongs to a different account');
    expect(JSON.parse(store.get(`system:blocks:step-quote:${quoteId}`) as string).consentedBy).toBe(
      null
    );
  });

  it('🔴 the caller names the kind and the id must be OF that kind — never inferred from the id', async () => {
    // Same hex, other prefix. A step dialog must not be able to confirm a training
    // quote (or the reverse): both mismatches are refused at the input, and the step
    // record is untouched.
    seedQuote(SEEDED, { consentedBy: null });
    const tq = `tq_${'1'.repeat(32)}`;
    await expect(
      caller(VIEWER).consentQuoteGrant({ kind: 'step', blockToken: 't', quoteId: tq } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(VIEWER).previewQuoteGrant({ kind: 'step', blockToken: 't', quoteId: tq } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(VIEWER).consentQuoteGrant({
        kind: 'training',
        blockToken: 't',
        quoteId: SEEDED,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(VIEWER).consentQuoteGrant({ blockToken: 't', quoteId: SEEDED } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(JSON.parse(store.get(`system:blocks:step-quote:${SEEDED}`) as string).consentedBy).toBe(
      null
    );
    // Positive control: the right kind for the id confirms it.
    await expect(consent(SEEDED)).resolves.toMatchObject({ consented: true });
  });

  it('records the confirmation; the preview shows only server-resolved values', async () => {
    const { snapshot } = await estimate();
    const quoteId = snapshot.stepQuote!.quoteId;
    h.buzzAccounts.mockImplementation(async () => ({ blue: 40, green: 900, yellow: 0 }));
    const preview = await caller(VIEWER).previewQuoteGrant({
      kind: 'step',
      blockToken: 't',
      quoteId,
    });
    expect(preview).toMatchObject({
      quoteId,
      total: PRICE,
      stepType: 'polyGen',
      // SFW token → blue + green are spendable: 40 + 900 = 940, short 100.
      shortfall: 100,
      // No limit set (the default) → unaffected.
      dailyLimit: null,
      exceedsDailyLimit: false,
    });
    await expect(consent(quoteId)).resolves.toMatchObject({ consented: true, total: PRICE });
    expect(JSON.parse(store.get(`system:blocks:step-quote:${quoteId}`) as string).consentedBy).toBe(
      VIEWER
    );
  });

  it('the preview reports the viewer’s daily limit and whether this job exceeds what remains', async () => {
    setDailyLimit(1500);
    const { snapshot } = await estimate();
    const quoteId = snapshot.stepQuote!.quoteId;
    // Nothing spent yet: 1500 left, a 1040 job fits.
    expect(
      await caller(VIEWER).previewQuoteGrant({ kind: 'step', blockToken: 't', quoteId })
    ).toMatchObject({
      dailyLimit: { limit: 1500, spentToday: 0, remaining: 1500 },
      exceedsDailyLimit: false,
    });
    // 600 already spent today on this app: 900 left, the 1040 job does not fit.
    const [limitKey] = keysWith('system:blocks:consent-budget');
    expect(limitKey).toBeUndefined();
    store.set(`system:blocks:consent-budget:${VIEWER}:apb_test:${dayKey()}`, '600');
    expect(
      await caller(VIEWER).previewQuoteGrant({ kind: 'step', blockToken: 't', quoteId })
    ).toMatchObject({
      dailyLimit: { limit: 1500, spentToday: 600, remaining: 900 },
      exceedsDailyLimit: true,
    });
  });
});

/** The UTC-day window the consent counter keys on (`buzzCapWindowKey`). */
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

describe('SUBMIT refusals — each with its own error, nothing charged', () => {
  async function expectNothingCharged() {
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
  }

  it('an UNCONFIRMED quote', async () => {
    const { snapshot } = await estimate();
    await expect(submit(body({ quoteId: snapshot.stepQuote!.quoteId }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this step has not been confirmed by the viewer in this session',
    });
    await expectNothingCharged();
  });

  it('a quote confirmed by ANOTHER user', async () => {
    seedQuote(SEEDED, { consentedBy: 7 });
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toThrow(
      'this step has not been confirmed by the viewer in this session'
    );
    await expectNothingCharged();
  });

  it.each([
    ['another viewer', { userId: 7, consentedBy: 7 }],
    ['another app', { appBlockId: 'apb_other' }],
    ['another install', { blockInstanceId: 'page_other' }],
  ])('a quote bound to %s', async (_l, over) => {
    seedQuote(SEEDED, over);
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this step quote belongs to a different viewer, app or install — estimate again',
    });
    await expectNothingCharged();
  });

  it('a body that differs from the quoted one — and the quote is spent', async () => {
    const quoteId = await confirmedQuote();
    await expect(
      submit(body({ quoteId, input: { engine: 'meshy', prompt: 'a cup' } }))
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'the step body differs from the one that was quoted — estimate again',
    });
    await expect(submit(body({ quoteId }))).rejects.toThrow('already used');
    await expectNothingCharged();
  });

  it('an expired / unknown quote', async () => {
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'step quote not found, expired or already used — estimate again',
    });
    await expectNothingCharged();
  });

  it('a REUSED quote: a repeat submit replays the first result, with no second charge', async () => {
    const quoteId = await confirmedQuote();
    const first = await submit(body({ quoteId }));
    const second = await submit(body({ quoteId }));
    expect(second).toEqual(first);
    expect(realSubmits()).toHaveLength(1);
    expect(counter('system:blocks:buzz-cap')).toBe(PRICE);
  });

  it('a requote HIGHER than the confirmed price', async () => {
    const quoteId = await confirmedQuote();
    whatifPrice = { total: PRICE + 1 };
    await expect(submit(body({ quoteId }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `the step price changed from ${PRICE} to ${
        PRICE + 1
      } Buzz since it was confirmed — estimate again`,
    });
    await expectNothingCharged();
  });

  // 🔴 Requoted prices that equal neither PRICE nor BUDGET, so a mutant that reserves
  // the confirmed total or the per-call budget instead of the requote cannot pass.
  it.each([
    ['still above the budget', 1017],
    ['now BELOW the budget (the grant still governs; nothing falls back)', 803],
  ])('a lower requote — %s — is charged at the requoted price', async (_l, requoted) => {
    const quoteId = await confirmedQuote();
    whatifPrice = { total: requoted };
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.workflowId).toBe(workflowId);
    expect(counter('system:blocks:buzz-cap')).toBe(requoted);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', requoted);
    expect(h.persistSettle).toHaveBeenCalledWith(expect.objectContaining({ ceiling: requoted }));
  });

  it('a confirmed quote ABOVE 5000 (the estimate never stores one)', async () => {
    seedQuote(SEEDED, { total: 6000 });
    whatifPrice = { total: 5500 };
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this job costs more than the per-job limit of 5000 Buzz for apps',
    });
    await expectNothingCharged();
  });

  it('a stored quote with no valid price', async () => {
    seedQuote(SEEDED, { total: 1040.5 });
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'this step quote has no valid price — estimate again',
    });
    await expectNothingCharged();
  });

  it.each([
    ['unquoted', null],
    ['a zero price', { total: 0 }],
    ['a variable price', { total: PRICE, variable: true }],
  ])('a requote that is %s', async (_l, price) => {
    const quoteId = await confirmedQuote();
    if (price === null) {
      h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
        if (args.query?.whatif) throw new Error('orchestrator down');
        throw new Error('no real submit expected');
      });
    } else {
      whatifPrice = price;
    }
    await expect(submit(body({ quoteId }))).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'the step price could not be confirmed — estimate again',
    });
    await expectNothingCharged();
  });

  it('a viewer who cannot pay the requoted price — before any reservation', async () => {
    const quoteId = await confirmedQuote();
    h.buzzAccounts.mockImplementation(async () => ({ blue: 40, green: 999, yellow: 50_000 }));
    await expect(submit(body({ quoteId }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Not enough Buzz for this job.',
    });
    expect(keysWith('system:blocks:buzz-cap')).toEqual([]);
    await expectNothingCharged();
  });

  it.each([
    [
      'a dev (and tunnel) token',
      claims({ dev: true }),
      'a confirmed step is not available from a development or review session',
    ],
    [
      'a review run-for-real token',
      claims({ reviewRunForReal: true }),
      'a confirmed step is not available from a development or review session',
    ],
    [
      'an editor (read-only) private run',
      claims({ privateRun: true, privateRunAudience: 'editor' }),
      'block token missing budget',
    ],
    [
      'a model-slot token',
      claims({ ctx: { modelId: 7, slotId: 'model.sidebar_top' } }),
      'a confirmed step is page-only',
    ],
  ])('%s', async (_l, c, msg) => {
    seedQuote(SEEDED);
    h.authorize.mockImplementation(async () => c);
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toThrow(msg);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    // The quote was never claimed.
    expect(keysWith(QUOTE_PREFIX)).toHaveLength(1);
  });

  it('a read-only token (no spend scope) is refused by the procedure gate', async () => {
    seedQuote(SEEDED);
    h.authorize.mockImplementation(async () => claims({ scopes: [] }));
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toThrow(
      'block lacks ai:write:budgeted scope'
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('the flag off', async () => {
    seedQuote(SEEDED);
    h.confirmedStepFlag.mockImplementation(async () => false);
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'confirmed steps from apps are not enabled',
    });
    await expect(
      caller(VIEWER).previewQuoteGrant({ kind: 'step', blockToken: 't', quoteId: SEEDED })
    ).rejects.toThrow('confirmed steps from apps are not enabled');
    await expect(consent(SEEDED)).rejects.toThrow('confirmed steps from apps are not enabled');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('a platform-internal $type is refused by the denylist before anything costs', async () => {
    seedQuote(SEEDED);
    await expect(submit(body({ quoteId: SEEDED, $type: 'imageScanning' }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('imageScanning'),
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    // Refused before the quote was claimed.
    expect(keysWith(QUOTE_PREFIX)).toHaveLength(1);
  });
});

describe('the viewer’s DAILY LIMIT — never overridden by the confirm', () => {
  it('a job exceeding what remains is refused with the machine-readable code, refunded', async () => {
    setDailyLimit(1500);
    store.set(`system:blocks:consent-budget:${VIEWER}:apb_test:${dayKey()}`, '600');
    const quoteId = await confirmedQuote();
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.status).toBe('failed');
    expect(r.snapshot.errorCode).toBe('daily-limit-exceeded');
    // The shared wording every arm uses for this limit; the CODE is what is new.
    expect(r.snapshot.error).toBe(
      'app Buzz limit reached: 600 already spent today by this app on your behalf, ' +
        `this job costs ${PRICE}, your limit for this app is 1500`
    );
    expect(realSubmits()).toHaveLength(0);
    // Every leg refunded: the consent counter is back at what was already spent.
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(Number(store.get(`system:blocks:consent-budget:${VIEWER}:apb_test:${dayKey()}`))).toBe(
      600
    );
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
  });

  // 🔴 THE BOUNDARY, both sides, at the submit AND the preview: remaining exactly
  // equal to the price runs; one Buzz less is refused. Kills a `<` ↔ `<=` mutant at
  // either site.
  it.each([
    [460, 'runs', false],
    [461, 'is refused', true],
  ])(
    'spent %i of a 1500 limit (1040 left vs 1039): the 1040 job %s',
    async (spent, _l, refused) => {
      setDailyLimit(1500);
      store.set(`system:blocks:consent-budget:${VIEWER}:apb_test:${dayKey()}`, String(spent));
      const quoteId = await confirmedQuote();
      const preview = await caller(VIEWER).previewQuoteGrant({
        kind: 'step',
        blockToken: 't',
        quoteId,
      });
      expect(preview.exceedsDailyLimit).toBe(refused);
      const r = await submit(body({ quoteId }));
      expect(r.snapshot.errorCode).toBe(refused ? 'daily-limit-exceeded' : undefined);
      expect(realSubmits()).toHaveLength(refused ? 0 : 1);
    }
  );

  it('a lower requote is what the limit is judged on, and what it is charged', async () => {
    setDailyLimit(1500);
    const quoteId = await confirmedQuote();
    whatifPrice = { total: 1017 };
    await submit(body({ quoteId }));
    expect(counter('system:blocks:consent-budget')).toBe(1017);
  });

  it('control: a job within the limit runs and is reserved against it', async () => {
    setDailyLimit(1500);
    const quoteId = await confirmedQuote();
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.workflowId).toBe(workflowId);
    expect(counter('system:blocks:consent-budget')).toBe(PRICE);
  });
});

describe('AGGREGATE caps still bind a confirmed job', () => {
  it('the per-user daily cap', async () => {
    store.set(`system:blocks:buzz-cap:${VIEWER}:${dayKey()}`, String(50_000 - 500));
    const quoteId = await confirmedQuote();
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.status).toBe('failed');
    expect(r.snapshot.error).toBe(
      `daily Buzz cap reached: ${50_000 - 500} already spent today across your installed apps, ` +
        `this job costs ${PRICE}, daily cap is 50000`
    );
    expect(realSubmits()).toHaveLength(0);
    expect(Number(store.get(`system:blocks:buzz-cap:${VIEWER}:${dayKey()}`))).toBe(50_000 - 500);
  });

  it('the per-app aggregate cap', async () => {
    const quoteId = await confirmedQuote();
    h.reserveAppSpend.mockResolvedValueOnce({ allowed: false, reason: 'daily' } as never);
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.error).toMatch(/^app daily spend cap reached/);
    expect(realSubmits()).toHaveLength(0);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
  });
});

describe('a submit billed ABOVE the confirmed price is detected', () => {
  it('counts it once under kind=step and logs the amounts', async () => {
    const quoteId = await confirmedQuote();
    chargedPrice = PRICE + 25;
    await submit(body({ quoteId }));
    expect(h.overcharge.mock.calls).toEqual([['step']]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'block-confirmed-quote-overcharge',
        kind: 'step',
        stepType: 'polyGen',
        confirmedBuzz: PRICE,
        chargedBuzz: PRICE,
        realizedBuzz: PRICE + 25,
        quoteId,
      })
    );
  });

  // 🔴 Compared against what the viewer is CHARGED (the requote), not the stored
  // quote total, and only in the ABOVE direction: a requote of 1017 billed at 1030 is
  // over the charge yet under the confirmed 1040 (must log); billed at 1000 or exactly
  // 1017 it must not.
  it.each([
    [1030, true],
    [1017, false],
    [1000, false],
  ])('a 1017 requote billed at %i logs an overcharge: %s', async (billed, logs) => {
    const quoteId = await confirmedQuote();
    whatifPrice = { total: 1017 };
    chargedPrice = billed;
    await submit(body({ quoteId }));
    const logged = loggingMock.logToAxiom.mock.calls.some(
      (c) => (c[0] as { name?: string }).name === 'block-confirmed-quote-overcharge'
    );
    expect(logged).toBe(logs);
    // The counter moves exactly when the log does.
    expect(h.overcharge).toHaveBeenCalledTimes(logs ? 1 : 0);
  });

  it('control: a submit billed exactly at the confirmed price logs nothing', async () => {
    const quoteId = await confirmedQuote();
    await submit(body({ quoteId }));
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'block-confirmed-quote-overcharge' })
    );
    expect(h.overcharge).not.toHaveBeenCalled();
  });
});

describe('every confirmation is its own run (keyed on the quote, not the body)', () => {
  it('two confirms of an IDENTICAL body submit under two distinct externalIds', async () => {
    const first = await confirmedQuote();
    await submit(body({ quoteId: first }));
    const second = await confirmedQuote();
    workflowId = `${VIEWER}-second`;
    const r = await submit(body({ quoteId: second }));
    expect(r.snapshot.workflowId).toBe(`${VIEWER}-second`);

    const ids = realSubmits().map(
      (c) => (c[0] as { body: { externalId: string } }).body.externalId
    );
    expect(ids).toEqual([`blc${first.slice(3)}`, `blc${second.slice(3)}`]);
    expect(ids[0]).not.toBe(ids[1]);
    // Both were charged, and nothing counts runs for this kind.
    expect(counter('system:blocks:buzz-cap')).toBe(2 * PRICE);
    expect(keysWith('system:blocks:step-quote')).toEqual([]);
  });
});

describe('a PRIVATE RUN — the one token rule shared with training', () => {
  it('the owner’s private run is granted a quote and runs, under the private-run cap', async () => {
    h.authorize.mockImplementation(async () =>
      claims({ privateRun: true, privateRunAudience: 'owner' })
    );
    const quoteId = await confirmedQuote();
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.workflowId).toBe(workflowId);
    expect(realSubmits()).toHaveLength(1);
    // Reserved against the private-run counter, not the viewer's daily one.
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(counter('system:blocks:private-run-buzz-cap')).toBe(PRICE);
    // The private-run marker reaches BOTH audit rows, so the run stays out of the
    // delisted app owner's analytics.
    await vi.waitFor(() => expect(h.recordSpendAttribution).toHaveBeenCalledTimes(1));
    expect(h.recordSpendAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ privateRun: true, workflowId })
    );
    await vi.waitFor(() => expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1));
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ privateRun: true, dev: false })
    );
  });

  it('…and a job above the private-run cap is refused by that cap', async () => {
    h.authorize.mockImplementation(async () =>
      claims({ privateRun: true, privateRunAudience: 'owner' })
    );
    whatifPrice = { total: 2501 };
    const quoteId = await confirmedQuote();
    const r = await submit(body({ quoteId }));
    expect(r.snapshot.status).toBe('failed');
    expect(r.snapshot.error).toBe('private run Buzz cap reached: this job costs 2501, cap is 2500');
    expect(realSubmits()).toHaveLength(0);
  });
});

describe('the flag is evaluated for a hydrated token subject', () => {
  it('an unhydratable subject gets no grant and cannot submit', async () => {
    h.getUserById.mockImplementation(async () => null);
    expect((await estimate()).snapshot.stepQuote).toBeUndefined();
    expect(h.confirmedStepFlag).not.toHaveBeenCalled();
    seedQuote(SEEDED);
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'user not found',
    });
    expect(realSubmits()).toHaveLength(0);
  });
});

afterEach(() => envMock.reset());

describe('orchestrator submit failures — the training contract', () => {
  it('tears down and refunds a job the orchestrator attributed to someone else', async () => {
    envMock.set({ ORCHESTRATOR_MODE: 'prod' });
    const quoteId = await confirmedQuote();
    workflowId = '7-20261012';
    await expect(submit(body({ quoteId }))).rejects.toThrow('could not confirm who this');
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.refundAppSpend).toHaveBeenCalledWith('app-daily', PRICE);
    expect(h.recordSpendAttribution).not.toHaveBeenCalled();
  });

  // 🔴 A DELIBERATE TRADE, pinned so it is not mistaken for an oversight: a step is keyed
  // on its quote, so after an unconfirmed submit there is NO orchestrator-side dedupe
  // for a retry — the spent quote cannot be reused, and a fresh estimate + confirm is a
  // NEW job with a new id. (Training keeps run-keyed dedupe.) That is why the reply
  // tells the viewer to check before retrying.
  it('an ambiguous failure is UNCONFIRMED, keeps every reservation, and a re-confirmed retry is a NEW job', async () => {
    const quoteId = await confirmedQuote();
    h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) return { cost: { total: PRICE } };
      throw new Error('socket hang up');
    });
    const r = await submit(body({ quoteId }));
    expect(r.submissionUnconfirmed).toBe(true);
    expect(r.snapshot.error).toBe(
      'the job could not be confirmed — it may be running; check your generations before retrying'
    );
    expect(counter('system:blocks:buzz-cap')).toBe(PRICE);
    expect(h.refundAppSpend).not.toHaveBeenCalled();
    expect(h.persistSettle).not.toHaveBeenCalled();
    // The quote is spent and the claim released: a retry needs a new estimate.
    await expect(submit(body({ quoteId }))).rejects.toThrow('step quote not found');
    // …and that retry is submitted under a DIFFERENT externalId.
    installOrchestrator();
    const retryQuote = await confirmedQuote();
    await submit(body({ quoteId: retryQuote }));
    const ids = realSubmits().map(
      (c) => (c[0] as { body: { externalId: string } }).body.externalId
    );
    expect(ids).toEqual([`blc${quoteId.slice(3)}`, `blc${retryQuote.slice(3)}`]);
  });

  it('a first-attempt orchestrator 4xx is definite: refunded and rethrown', async () => {
    const quoteId = await confirmedQuote();
    let thrown: unknown;
    h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
      if (args.query?.whatif) return { cost: { total: PRICE } };
      try {
        throwBadRequestError('model is not enabled');
      } catch (e) {
        thrown = e;
      }
      annotateOrchestratorSubmitFailure(thrown, { attempt: 1, status: 422 });
      throw thrown;
    });
    await expect(submit(body({ quoteId }))).rejects.toBeInstanceOf(TRPCError);
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(h.refundAppSpend).toHaveBeenCalledWith('app-daily', PRICE);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'block-confirmed-step-submit-failed', outcome: 'refused' })
    );
  });
});

describe('the generation input gate runs on a CONFIRMED submit too', () => {
  const OTHER_USER = 7;
  const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
  const CDN = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/original=true`;
  const imageBody = (over: Record<string, unknown> = {}) =>
    body({ input: { engine: 'meshy', prompt: 'a teapot', image: CDN }, ...over });

  /** The image row the gate reads for KEY: owner and visibility as given. */
  function givenImage(owner: number, visible: boolean) {
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('').includes('FROM "Image" i')
        ? [{ url: KEY, userId: owner, visible, blocked: false }]
        : []) as never);
  }
  beforeEach(() =>
    seedQuote(SEEDED, {
      bodyHash: hashPassThroughStepBody(blockPassThroughStepBodySchema.parse(imageBody())),
    })
  );
  afterEach(() => dbMock.dbWrite.$queryRaw.mockReset());

  it("refuses another user's private image, with nothing charged and the quote unclaimed", async () => {
    givenImage(OTHER_USER, false);
    await expect(submit(imageBody({ quoteId: SEEDED }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter('system:blocks:buzz-cap')).toBe(0);
    expect(keysWith(QUOTE_PREFIX)).toHaveLength(1);
  });

  it('control: the same quoted body with the viewer’s own image runs', async () => {
    givenImage(VIEWER, false);
    const r = await submit(imageBody({ quoteId: SEEDED }));
    expect(r.snapshot.workflowId).toBe(workflowId);
    expect(realSubmits()).toHaveLength(1);
  });
});
