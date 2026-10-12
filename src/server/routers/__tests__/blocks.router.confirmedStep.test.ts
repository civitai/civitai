import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import type * as SessionClientModule from '~/server/auth/session-client';

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
  getUserById: vi.fn(async () => ({ id: 42, isModerator: false })),
  sessionUser: vi.fn(async (): Promise<unknown> => ({ id: 42, isModerator: false })),
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
vi.mock('~/server/auth/session-client', async (importOriginal) => {
  const mod = await importOriginal<typeof SessionClientModule>();
  return {
    ...mod,
    sessionClient: new Proxy(mod.sessionClient, {
      get: (target, prop, receiver) =>
        prop === 'getSessionUserById'
          ? (...a: unknown[]) => h.sessionUser(...(a as []))
          : Reflect.get(target, prop, receiver),
    }),
  };
});
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenAccessModule>()),
  assertAppBlocksEnabledForTokenUser: (...a: unknown[]) => h.assertEnabled(...(a as [])),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagModule>()),
  isAppBlocksConfirmedStepEnabled: (...a: unknown[]) => h.confirmedStepFlag(...(a as [])),
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
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { BLOCK_STEP_NAME } from '~/server/services/blocks/workflow.service';
import { composeConfirmedStepBlockExternalId } from '~/server/utils/block-gen-idempotency';
import {
  hashPassThroughStepBody,
  quotedRunKey,
} from '~/server/services/blocks/block-quote-grant.service';
import { blockPassThroughStepBodySchema } from '~/server/schema/blocks/workflow.schema';

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
  return caller(sessionUserId).consentStepQuote({ blockToken: 't', quoteId });
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
  h.sessionUser.mockImplementation(async () => ({ id: VIEWER, isModerator: false }));
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
    // Keyed on the RUN (viewer, app, body, generation 0), the way training is.
    expect(req.body.externalId).toBe(
      composeConfirmedStepBlockExternalId(quotedRunKey('apb_test', BODY_HASH(), 0))
    );
    expect(req.body.externalId.startsWith('blc')).toBe(true);

    expect(counter('system:blocks:buzz-cap')).toBe(PRICE);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', PRICE);
    expect(h.persistSettle).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId, ceiling: PRICE, engine: 'passthrough' })
    );
    // Single use: the quote is gone, and the run generation moved.
    expect(keysWith(QUOTE_PREFIX)).toEqual([]);
    expect(store.get(`system:blocks:step-quote:runs:${VIEWER}:apb_test:${BODY_HASH()}`)).toBe('1');
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

  it.each([
    ['the flag is off', claims(), false],
    ['a dev token', claims({ dev: true }), true],
    ['a review run-for-real token', claims({ reviewRunForReal: true }), true],
    ['a private-run token', claims({ privateRun: true, privateRunAudience: 'owner' }), true],
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

describe('CONSENT — session-only, and only the quote’s own subject', () => {
  it('requires a signed-in session (the block, holding only its token, cannot call it)', async () => {
    const { snapshot } = await estimate();
    await expect(
      caller(undefined).consentStepQuote({ blockToken: 't', quoteId: snapshot.stepQuote!.quoteId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller(undefined).previewStepQuote({ blockToken: 't', quoteId: snapshot.stepQuote!.quoteId })
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

  it('refuses a training quote id (another kind) at the input', async () => {
    await expect(consent(`tq_${'1'.repeat(32)}`)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('records the confirmation; the preview shows only server-resolved values', async () => {
    const { snapshot } = await estimate();
    const quoteId = snapshot.stepQuote!.quoteId;
    h.buzzAccounts.mockImplementation(async () => ({ blue: 40, green: 900, yellow: 0 }));
    const preview = await caller(VIEWER).previewStepQuote({ blockToken: 't', quoteId });
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
    expect(await caller(VIEWER).previewStepQuote({ blockToken: 't', quoteId })).toMatchObject({
      dailyLimit: { limit: 1500, spentToday: 0, remaining: 1500 },
      exceedsDailyLimit: false,
    });
    // 600 already spent today on this app: 900 left, the 1040 job does not fit.
    const [limitKey] = keysWith('system:blocks:consent-budget');
    expect(limitKey).toBeUndefined();
    store.set(`system:blocks:consent-budget:${VIEWER}:apb_test:${dayKey()}`, '600');
    expect(await caller(VIEWER).previewStepQuote({ blockToken: 't', quoteId })).toMatchObject({
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
    ['a dev (and tunnel) token', claims({ dev: true }), 'development, review or private-run'],
    [
      'a review run-for-real token',
      claims({ reviewRunForReal: true }),
      'development, review or private-run',
    ],
    [
      'a private-run token',
      claims({ privateRun: true, privateRunAudience: 'owner' }),
      'development, review or private-run',
    ],
    [
      'an editor (read-only) private run',
      claims({ privateRun: true, privateRunAudience: 'editor' }),
      'development, review or private-run',
    ],
    [
      'a model-slot token',
      claims({ ctx: { modelId: 7, slotId: 'model.sidebar_top' } }),
      'page-only',
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
      caller(VIEWER).previewStepQuote({ blockToken: 't', quoteId: SEEDED })
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
      const preview = await caller(VIEWER).previewStepQuote({ blockToken: 't', quoteId });
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
  it('logs the overcharge with both amounts', async () => {
    const quoteId = await confirmedQuote();
    chargedPrice = PRICE + 25;
    await submit(body({ quoteId }));
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'block-confirmed-step-overcharge',
        confirmedBuzz: PRICE,
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
      (c) => (c[0] as { name?: string }).name === 'block-confirmed-step-overcharge'
    );
    expect(logged).toBe(logs);
  });

  it('control: a submit billed exactly at the confirmed price logs nothing', async () => {
    const quoteId = await confirmedQuote();
    await submit(body({ quoteId }));
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'block-confirmed-step-overcharge' })
    );
  });
});

describe('the flag is evaluated for a hydrated token subject', () => {
  it('an unhydratable subject gets no grant and cannot submit', async () => {
    h.sessionUser.mockImplementation(async () => null);
    expect((await estimate()).snapshot.stepQuote).toBeUndefined();
    expect(h.confirmedStepFlag).not.toHaveBeenCalled();
    seedQuote(SEEDED);
    await expect(submit(body({ quoteId: SEEDED }))).rejects.toThrow(
      'confirmed steps from apps are not enabled'
    );
  });
});

describe('orchestrator submit failures — the training contract', () => {
  it('an ambiguous failure is UNCONFIRMED and keeps every reservation', async () => {
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
    // The run generation did not move, so a re-confirmed retry reuses the externalId.
    expect(keysWith('system:blocks:step-quote:runs')).toEqual([]);
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
