import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { annotateOrchestratorSubmitFailure } from '~/server/services/orchestrator/submit-failure';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as AttributionModule from '~/server/services/blocks/buzz-attribution.service';
import type * as AuthorFeeChargeModule from '~/server/services/blocks/author-fee-charge.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as SettleModule from '~/server/services/blocks/custom-comfy-settle.service';
import type * as AppSpendModule from '~/server/services/blocks/app-spend-cap.service';
import type * as DevTunnelModule from '~/server/services/blocks/dev-tunnel.service';
import type * as BlockWorkflowsModule from '~/server/services/blocks/block-workflows.service';
import type * as SurfaceModule from '~/server/services/blocks/user-app-surface.service';
import type * as WorkflowsModule from '~/server/services/orchestrator/workflows';
import type * as FliptModule from '~/server/flipt/client';

/**
 * `kind:'workflow'` end to end through `blocksRouter`: estimate, submit, poll and
 * the batch estimate. The cap reservation helpers, the idempotency claim and the
 * author-fee QUOTE run for real over an in-memory Redis; the orchestrator, the
 * per-app cap, the fee charge and the audit writers are stubbed and their
 * arguments asserted.
 *
 * FIXTURE NUMBERS. The token's per-generation budget is 37 and the default body
 * has 3 steps, so the ceiling is 111 — a product no other constant here equals.
 * Quotes are chosen to OVERSHOOT a wrong ceiling rather than sit on a boundary:
 * 64 is above one budget (37) and below three; 110 + a fee of 5 is above three
 * and below four (148).
 */

/** The external-host refusal flag; every other flag reads as it does unmocked. */
const flags = vi.hoisted(() => ({ refuseExternal: false, refuseExternalApp: true }));

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertEnabled: vi.fn(async () => undefined),
  authorFeeFlag: vi.fn(async () => true),
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(async () => undefined),
  reserveAppSpend: vi.fn(),
  refundAppSpend: vi.fn(async () => undefined),
  persistSettle: vi.fn(async () => undefined),
  settle: vi.fn(async () => undefined),
  recordSpendAttribution: vi.fn(async () => undefined),
  chargeAuthorFee: vi.fn(async () => ({ charged: false, reason: 'not-reserved' })),
  reverseAuthorFee: vi.fn(async () => undefined),
  recordScopeInvocation: vi.fn(async () => undefined),
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
  isAppBlocksAuthorFeeEnabled: (...a: unknown[]) => h.authorFeeFlag(...(a as [])),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptModule>();
  const isFlipt = (async (flag: string, ...rest: unknown[]) =>
    flag === actual.FLIPT_FEATURE_FLAGS.GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS
      ? flags.refuseExternal
      : flag === actual.FLIPT_FEATURE_FLAGS.APP_BLOCK_REFUSE_EXTERNAL_SOURCES
      ? flags.refuseExternalApp
      : (actual.isFlipt as (...a: unknown[]) => Promise<boolean>)(
          flag,
          ...rest
        )) as typeof actual.isFlipt;
  return { ...actual, isFlipt };
});
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: () => h.getOrchestratorToken(),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsModule>()),
  submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
  getWorkflow: (...a: unknown[]) => h.getWorkflow(...a),
  cancelWorkflow: (...a: unknown[]) => h.cancelWorkflow(...(a as [])),
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSpendModule>()),
  reserveAppSpend: (...a: unknown[]) => h.reserveAppSpend(...a),
  refundAppSpend: (...a: unknown[]) => h.refundAppSpend(...(a as [])),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DevTunnelModule>()),
  getActiveDevTunnel: (...a: unknown[]) => h.getActiveDevTunnel(...(a as [])),
  reserveDevSessionBuzz: (...a: unknown[]) => h.reserveDevSessionBuzz(...a),
  refundDevSessionBuzz: (...a: unknown[]) => h.refundDevSessionBuzz(...(a as [])),
}));
vi.mock('~/server/services/blocks/block-workflows.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockWorkflowsModule>()),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
  updateBlockWorkflowStatus: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SettleModule>()),
  persistCustomComfySettle: (...a: unknown[]) => h.persistSettle(...(a as [])),
  settleCustomComfySpend: (...a: unknown[]) => h.settle(...(a as [])),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AttributionModule>()),
  recordSpendAttribution: (...a: unknown[]) => h.recordSpendAttribution(...(a as [])),
}));
// The QUOTE is real (flag + payee lookup + the fee formula); only the debit and
// the reversal are stubbed.
vi.mock('~/server/services/blocks/author-fee-charge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthorFeeChargeModule>()),
  chargeBlockAuthorFee: (...a: unknown[]) => h.chargeAuthorFee(...(a as [])),
  reverseBlockAuthorFee: (...a: unknown[]) => h.reverseAuthorFee(...(a as [])),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SurfaceModule>()),
  recordScopeInvocation: (...a: unknown[]) => h.recordScopeInvocation(...(a as [])),
}));
// The per-user caps resolver reads the session user; unmocked, it reaches the real redis client.
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  checkBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockEstimateCellsRateLimit: vi.fn(async () => ({ allowed: true })),
  checkBlockPollRateLimit: vi.fn(async () => ({ allowed: true })),
}));
// Same shim the sibling router suites use: cuts the Prisma-generated chain that
// `rateLimit` pulls in. Rate limiting through it is not under test here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
// The submit reaches these through `await import()` inside fire-and-forget
// closures. Loading them here means no closure can overlap a first, in-flight load.
import '~/server/services/blocks/user-app-surface.service';
import '~/server/services/blocks/buzz-attribution.service';
import '~/server/services/blocks/block-workflows.service';
import '~/server/services/blocks/app-spend-cap.service';
import '~/server/services/blocks/dev-tunnel.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { PlatformInternalStepTypeError } from '~/server/services/blocks/steps/orchestrator-denylist';
import { formatStepTimeout } from '~/server/services/blocks/workflow.service';
import {
  APP_SOURCE_UNUSABLE_MESSAGE,
  GENERATION_EXTERNAL_IMAGE_MESSAGE,
  GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
} from '~/server/services/generation-input-urls';
import * as z from 'zod';
import { getBlockTool } from '~/server/services/blocks/tools/registry';
import { ANON_SUBJECT } from '~/server/services/block-token-subject';
import { recordUploadKeyOwner } from '~/server/services/image-url-ownership';
import { TRAINING_WORKFLOW_TAG } from '~/server/services/orchestrator/training/workflow-state';

// ── An in-memory sysRedis: get/set (NX)/del/incrBy/decrBy. ──────────────────
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
const counter = (prefix: string) =>
  [...store.keys()]
    .filter((k) => k.startsWith(prefix))
    .reduce((s, k) => s + Number(store.get(k) ?? 0), 0);
const keysWith = (fragment: string) => [...store.keys()].filter((k) => k.includes(fragment));
const USER_CAP = 'system:blocks:buzz-cap';
const CONSENT_BUDGET = 'system:blocks:consent-budget';
/** Idempotency claims hold a sentinel or a JSON result, so they are counted by key. */
const idemKeys = () => keysWith(':apb_test:idem-key-');

// ── Fixtures ────────────────────────────────────────────────────────────────
const VIEWER = 42;
const APP_OWNER = 999;
const BUDGET = 37;
const STEPS = 3;
const CEILING = BUDGET * STEPS; // 111

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

const GEN_INPUT = { prompt: 'a cat', model: 'urn:air:sdxl:checkpoint:civitai:1@1' };
const UPSCALE_INPUT = { image: { $ref: 'gen', path: 'output.images[0].url' } };
const CONVERT_INPUT = {
  image: { $ref: '$1', path: 'output.blob.url' },
  strength: { $ref: '$arguments', path: 'strength' },
};

function body(over: Record<string, unknown> = {}) {
  return {
    kind: 'workflow' as const,
    steps: [
      { name: 'gen', $type: 'imageGen', input: GEN_INPUT },
      { $type: 'imageUpscaler', input: UPSCALE_INPUT, suppressOutput: true },
      { $type: 'transcode', input: CONVERT_INPUT },
    ],
    arguments: { strength: 0.4 },
    ...over,
  };
}

type Cost = { total?: number; base?: number; variable?: boolean };
let whatifCost: Cost | undefined = { total: 64, base: 60 };
let whatifError: unknown = null;
let realizedCost: Cost = { total: 64, base: 60 };
let submitError: unknown = null;
const WORKFLOW_ID = `${VIEWER}-20261012`;

type SubmitArgs = {
  body: {
    steps: Array<Record<string, unknown>>;
    tags: string[];
    arguments?: unknown;
    metadata?: Record<string, unknown>;
    externalId?: string;
    allowMatureContent?: boolean;
    nsfwLevel?: string;
  };
  query?: { whatif?: boolean };
};
function installOrchestrator() {
  h.submitWorkflow.mockImplementation(async (args: SubmitArgs) => {
    if (args.query?.whatif) {
      if (whatifError) throw whatifError;
      return { id: 'whatif-id', status: 'scheduled', ...(whatifCost ? { cost: whatifCost } : {}) };
    }
    if (submitError) throw submitError;
    return {
      id: WORKFLOW_ID,
      status: 'scheduled',
      cost: realizedCost,
      transactions: { list: [] },
      metadata: args.body.metadata,
      steps: args.body.steps.map((s) => ({ ...s, status: 'scheduled' })),
    };
  });
}
const calls = (whatif: boolean) =>
  h.submitWorkflow.mock.calls
    .map((c) => c[0] as SubmitArgs)
    .filter((a) => (a.query?.whatif === true) === whatif);
const realSubmits = () => calls(false);
const whatifs = () => calls(true);

/** What `submitWorkflow` throws for an orchestrator reply with this status. */
function orchestratorError(status: number, message: string) {
  const err = new TRPCError({
    code: status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
    message,
  });
  annotateOrchestratorSubmitFailure(err, { status, attempt: 1 });
  return err;
}
const REJECTION_REASON = 'Step 2 references an output that step 1 does not produce.';
const REJECTED_NO_REASON =
  'the orchestrator rejected the request; check the step inputs and references ' +
  '(retrying the same body will not help)';
/** Each way a quote is missing, and the clause every refusal message ends with. */
const QUOTE_FAILURES = [
  {
    name: 'a 400 with a safe reason',
    arrange: () => void (whatifError = orchestratorError(400, REJECTION_REASON)),
    errorCode: 'workflow_quote_rejected',
    cause: `the orchestrator rejected the request: ${REJECTION_REASON}`,
  },
  {
    name: 'a 400 whose reason is withheld',
    arrange: () => void (whatifError = orchestratorError(400, 'Could not read s3://datasets/a')),
    errorCode: 'workflow_quote_rejected',
    cause: REJECTED_NO_REASON,
  },
  {
    name: 'a 503',
    arrange: () => void (whatifError = orchestratorError(503, 'upstream down')),
    errorCode: 'workflow_quote_unavailable',
    cause: 'none could be obtained; try again',
  },
  {
    name: 'an answer with no total',
    arrange: () => void (whatifCost = { base: 60 }),
    errorCode: 'workflow_quote_unpriced',
    cause: 'the orchestrator answered without one',
  },
] as const;

function ctx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}
const caller = () => blocksRouter.createCaller(ctx() as never);
type Snap = {
  workflowId: string;
  status: string;
  error?: string;
  errorCode?: string;
  cost?: { total: number; authorFee?: number };
  imageUrls?: string[];
  steps?: Array<Record<string, unknown>>;
};
async function estimate(b: Record<string, unknown> = body()) {
  return (await caller().estimateWorkflow({ blockToken: 't', body: b as never })) as {
    snapshot: Snap;
  };
}
async function submit(b: Record<string, unknown> = body(), idempotencyKey?: string) {
  return (await caller().submitWorkflow({
    blockToken: 't',
    body: b as never,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })) as { snapshot: Snap };
}

beforeEach(() => {
  flags.refuseExternalApp = true;
  // Only the submit's account-restriction read gets a row; other user reads keep the default.
  dbMock.dbWrite.user.findUnique.mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) =>
    Object.keys(args.select ?? {})
      .sort()
      .join() === 'bannedAt,muted'
      ? { muted: false, bannedAt: null }
      : undefined) as never);
  store.clear();
  for (const fn of Object.values(h)) fn.mockClear();
  loggingMock.logToAxiom.mockClear();
  installRedis();
  installOrchestrator();
  whatifCost = { total: 64, base: 60 };
  whatifError = null;
  realizedCost = { total: 64, base: 60 };
  submitError = null;
  h.authorize.mockImplementation(async () => claims());
  h.authorFeeFlag.mockImplementation(async () => true);
  h.getOrchestratorToken.mockImplementation(async () => 'orch-token');
  h.reserveAppSpend.mockImplementation(async () => ({ allowed: true, dailyKey: 'app-daily' }));
  h.getActiveDevTunnel.mockImplementation(async () => null);
  h.reserveDevSessionBuzz.mockReset();
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);
  // The fee's payee: an owner who is NOT the viewer (no self-dealing skip).
  dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ id: 'app_test', userId: APP_OWNER });
  // Every Civitai version a step names exists, on a base model apps may use.
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) => args.where.id.in.map((id) => ({ id, baseModel: 'SDXL 1.0' }))) as never);
});
afterEach(() => envMock.reset());

// base 60 → max(flat 1, 5% × 60 = 3) = 3.
const FEE = 3;
const QUOTE = 64;

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' ESTIMATE", () => {
  it('prices the WHOLE workflow in one whatif and itemises ONE author fee', async () => {
    const { snapshot } = await estimate();
    expect(snapshot).toEqual({
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: QUOTE + FEE, authorFee: FEE },
    });
    expect(whatifs()).toHaveLength(1);
    expect(realSubmits()).toHaveLength(0);
    expect(counter(USER_CAP)).toBe(0);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
  });

  it('sends every step named, with its input UNMODIFIED, plus arguments and constant tags', async () => {
    const b = body();
    await estimate(b);
    const req = whatifs()[0].body;
    expect(req.steps).toEqual([
      { $type: 'imageGen', name: 'gen', input: GEN_INPUT },
      { $type: 'imageUpscaler', name: '$1', input: UPSCALE_INPUT },
      { $type: 'transcode', name: '$2', input: CONVERT_INPUT },
    ]);
    expect(req.arguments).toEqual({ strength: 0.4 });
    // No app text in a tag: the type slot is the kind, the model slot a constant.
    expect(req.tags).toEqual([
      'gen',
      'img',
      'workflow',
      'multistep',
      'app-block',
      'app-block:app_test',
      'app-block:block:blk_test',
      'app-block:instance:page_apb_test',
    ]);
    // An SFW token clamps maturity on the workflow, which covers every step.
    expect(req.allowMatureContent).toBe(false);
    expect(req.externalId).toBeUndefined();
    expect(req.metadata).toBeUndefined();
  });

  it.each(QUOTE_FAILURES)(
    '🔴 with NO quote ($name) is a failed snapshot coded $errorCode, never the ceiling as a price',
    async ({ arrange, errorCode, cause }) => {
      arrange();
      const { snapshot } = await estimate();
      expect(snapshot).toEqual({
        workflowId: 'failed',
        status: 'failed',
        errorCode,
        error: `No price quote for this workflow: ${cause}`,
      });
      expect(whatifs()).toHaveLength(1);
    }
  );

  it('a quote of ZERO is a price, not a missing quote', async () => {
    whatifCost = { total: 0, base: 0 };
    const { snapshot } = await estimate();
    expect(snapshot).toEqual({
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: 0, authorFee: 0 },
    });
  });

  it('a rejection may name an id the app sent, in a step input or in `arguments`, and no other', async () => {
    const OWN_STEP_ID = 'AMXT0PQ4Z8K2N6W1R5V9C3J7H0B4D8F2';
    const OWN_ARGUMENT_ID = 'KD83HF02JS91LQ47ZX65MN28CV30BT19';
    const FOREIGN_ID = 'ZQ7L2M9X4C1V8B5N0K3J6H2G9F4D1S7A';
    const b = body({
      steps: [{ $type: 'echo', input: { blob: OWN_STEP_ID } }],
      arguments: { other: OWN_ARGUMENT_ID },
    });
    for (const id of [OWN_STEP_ID, OWN_ARGUMENT_ID]) {
      whatifError = orchestratorError(404, `The blob ${id} was not found.`);
      expect((await estimate(b)).snapshot.error).toBe(
        `No price quote for this workflow: the orchestrator rejected the request: The blob ${id} was not found.`
      );
    }
    whatifError = orchestratorError(404, `The blob ${FOREIGN_ID} was not found.`);
    expect((await estimate(b)).snapshot.error).toBe(
      `No price quote for this workflow: ${REJECTED_NO_REASON}`
    );
  });

  it('an orchestrator reply with no `cost` at all is unpriced too', async () => {
    whatifCost = undefined;
    const { snapshot } = await estimate();
    expect(snapshot.errorCode).toBe('workflow_quote_unpriced');
    expect(snapshot.cost).toBeUndefined();
  });

  it('a token that cannot be minted is unavailable, with no whatif sent', async () => {
    h.getOrchestratorToken.mockRejectedValueOnce(new Error('mint down'));
    const { snapshot } = await estimate();
    expect(snapshot).toEqual({
      workflowId: 'failed',
      status: 'failed',
      errorCode: 'workflow_quote_unavailable',
      error: 'No price quote for this workflow: none could be obtained; try again',
    });
    expect(whatifs()).toHaveLength(0);
  });

  it('refuses an unquoted workflow that runs a TRAINING step, as the submit does', async () => {
    whatifCost = undefined;
    const { snapshot } = await estimate(
      body({
        steps: [
          { $type: 'echo', input: {} },
          { $type: 'training', input: {} },
        ],
      })
    );
    expect(snapshot).toEqual({
      workflowId: 'failed',
      status: 'failed',
      errorCode: 'training-quote-unpriced',
      error: 'Training needs a price quote and the orchestrator answered without one.',
    });
  });

  it('prices no fee on a cap-priced quote, and none when the fee flag is off', async () => {
    whatifCost = { total: 64, base: 60, variable: true };
    expect((await estimate()).snapshot.cost).toEqual({ total: 64, authorFee: 0 });
    whatifCost = { total: 64, base: 60 };
    h.authorFeeFlag.mockImplementation(async () => false);
    expect((await estimate()).snapshot.cost).toEqual({ total: 64, authorFee: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' — refusals a block can branch on (estimate AND submit)", () => {
  const paths = [
    ['estimate', estimate],
    ['submit', submit],
  ] as const;

  it.each(paths)(
    '🔴 %s: the DENYLIST runs on every step and names the step index',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          steps: [
            { $type: 'imageGen', input: GEN_INPUT },
            { $type: 'imageUpscaler', input: {} },
            { $type: 'xGuardModeration', input: {} },
          ],
        })
      );
      expect(snapshot).toEqual({
        workflowId: 'failed',
        status: 'failed',
        errorCode: 'workflow_step_denied',
        error:
          "workflow step 2: orchestrator step type 'xGuardModeration' is platform-internal and " +
          'cannot be submitted by an app block',
      });
      // Before the token mint, the quote and every reservation.
      expect(h.getOrchestratorToken).not.toHaveBeenCalled();
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
      expect(idemKeys()).toEqual([]);
      expect(h.reserveAppSpend).not.toHaveBeenCalled();
    }
  );

  it.each(paths)('🔴 %s: a raw customComfy step is denied', async (_n, run) => {
    const graph = { '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } } };
    const { snapshot } = await run(
      body({ steps: [{ $type: 'customComfy', input: { workflow: graph, resources: [] } }] })
    );
    expect(snapshot.errorCode).toBe('workflow_step_denied');
    expect(snapshot.error).toContain("workflow step 0: orchestrator step type 'customComfy'");
    expect(h.getOrchestratorToken).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter(USER_CAP)).toBe(0);
  });

  it.each(paths)('%s: the denylist is case-folded, like the pass-through arm', async (_n, run) => {
    const { snapshot } = await run(body({ steps: [{ $type: 'MEDIAHASH', input: {} }] }));
    expect(snapshot.errorCode).toBe('workflow_step_denied');
    expect(snapshot.error).toContain('workflow step 0');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each(paths)(
    '%s: a repeat template $type outside ASCII letters and digits is denied',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          arguments: { frames: [{ url: 'a' }] },
          steps: [
            {
              $type: 'repeat',
              input: {
                for: { $ref: '$arguments', path: 'frames', as: 'frame' },
                template: { $type: 'cu\u017ftomComfy', input: { workflow: {} } },
              },
            },
          ],
        })
      );
      expect(snapshot.errorCode).toBe('workflow_step_denied');
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(paths)('🔴 %s: the denylist covers the step a `repeat` runs', async (_n, run) => {
    const { snapshot } = await run(
      body({
        arguments: { frames: [{ url: 'a' }] },
        steps: [
          { $type: 'echo', input: {} },
          {
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'frames', as: 'frame' },
              template: { $type: 'imageScanning', input: { url: { $ref: 'frame', path: 'url' } } },
            },
          },
        ],
      })
    );
    expect(snapshot.errorCode).toBe('workflow_step_denied');
    expect(snapshot.error).toBe(
      "workflow step 1: orchestrator step type 'imageScanning' is platform-internal and " +
        'cannot be submitted by an app block'
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each(paths)(
    '🔴 %s: a `repeat` whose template key is re-cased is refused, not half-checked',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          steps: [
            {
              $type: 'repeat',
              input: {
                for: { $ref: '$arguments', path: 'images', as: 'image' },
                Template: { $type: 'imageScanning', input: {} },
              },
            },
          ],
        })
      );
      expect(snapshot.errorCode).toBe('workflow_ref_invalid');
      expect(snapshot.error).toBe(
        'workflow step 0: a repeat step needs exactly { for: { $ref, path, as }, template: { $type, name?, input? } }, nested at most 4 deep'
      );
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(paths)(
    '%s: an unquoted workflow that runs TRAINING inside a `repeat` is refused',
    async (_n, run) => {
      whatifCost = undefined;
      const { snapshot } = await run(
        body({
          arguments: { sets: ['one'] },
          steps: [
            {
              $type: 'repeat',
              input: {
                for: { $ref: '$arguments', path: 'sets', as: 'set' },
                template: { $type: 'training', input: {} },
              },
            },
          ],
        })
      );
      expect(snapshot.status).toBe('failed');
      expect(snapshot.errorCode).toBe('training-quote-unpriced');
      expect(realSubmits()).toHaveLength(0);
      expect(counter(USER_CAP)).toBe(0);
    }
  );

  it.each(paths)(
    '🔴 %s: a `merge` that reads a LATER step is `workflow_ref_invalid`',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          steps: [
            {
              $type: 'merge',
              input: { fields: { tags: { $ref: 'scan', path: 'output.tags', reduce: 'push' } } },
            },
            { name: 'scan', $type: 'wdTagging', input: {} },
          ],
        })
      );
      expect(snapshot).toEqual({
        workflowId: 'failed',
        status: 'failed',
        errorCode: 'workflow_ref_invalid',
        error: 'workflow step 0: "$ref": "scan" does not name "$arguments" or an earlier step',
      });
      expect(h.getOrchestratorToken).not.toHaveBeenCalled();
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(paths)(
    '%s: a `repeat` template may not set a server-owned step field',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          steps: [
            {
              $type: 'repeat',
              input: {
                for: { $ref: '$arguments', path: 'images', as: 'image' },
                template: { $type: 'wdTagging', input: {}, priority: 'high' },
              },
            },
          ],
        })
      );
      expect(snapshot.errorCode).toBe('workflow_ref_invalid');
      expect(snapshot.error).toBe(
        'workflow step 0: a repeat step needs exactly { for: { $ref, path, as }, template: { $type, name?, input? } }, nested at most 4 deep'
      );
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(paths)(
    '🔴 %s: a `repeat` over an EARLIER STEP is `workflow_repeat_unbounded`',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          steps: [
            { name: 'frames', $type: 'videoFrameExtraction', input: {} },
            {
              $type: 'repeat',
              input: {
                for: { $ref: 'frames', path: 'output.frames', as: 'frame' },
                template: {
                  $type: 'wdTagging',
                  input: { mediaUrl: { $ref: 'frame', path: 'url' } },
                },
              },
            },
          ],
        })
      );
      expect(snapshot).toEqual({
        workflowId: 'failed',
        status: 'failed',
        errorCode: 'workflow_repeat_unbounded',
        error:
          'workflow step 1: a repeat may only iterate over the workflow\'s own arguments ("$ref": ' +
          '"$arguments"), not "frames" — pass the list in "arguments" instead',
      });
      expect(h.getOrchestratorToken).not.toHaveBeenCalled();
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
      expect(h.reserveAppSpend).not.toHaveBeenCalled();
    }
  );

  it.each(paths)(
    '%s: a NESTED repeat over the outer loop variable is refused the same way',
    async (_n, run) => {
      const { snapshot } = await run(
        body({
          arguments: { images: [{ tiles: [1, 2] }] },
          steps: [
            {
              $type: 'Repeat',
              input: {
                for: { $ref: '$arguments', path: 'images', as: 'image' },
                template: {
                  $type: 'repeat',
                  input: {
                    for: { $ref: 'image', path: 'tiles', as: 'tile' },
                    template: { $type: 'wdTagging', input: {} },
                  },
                },
              },
            },
          ],
        })
      );
      expect(snapshot.errorCode).toBe('workflow_repeat_unbounded');
      expect(snapshot.error).toContain('workflow step 0: a repeat may only iterate over');
      expect(snapshot.error).toContain('not "image"');
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(paths)(
    '🔴 %s: a repeat over more than 16 arguments is `workflow_repeat_unbounded`',
    async (_n, run) => {
      const repeatOver = (count: number) =>
        body({
          arguments: { images: Array.from({ length: count }, (_, i) => ({ url: `u${i}` })) },
          steps: [
            {
              $type: 'repeat',
              input: {
                for: { $ref: '$arguments', path: 'images', as: 'image' },
                template: {
                  $type: 'wdTagging',
                  input: { mediaUrl: { $ref: 'image', path: 'url' } },
                },
              },
            },
          ],
        });
      const { snapshot } = await run(repeatOver(17));
      expect(snapshot).toEqual({
        workflowId: 'failed',
        status: 'failed',
        errorCode: 'workflow_repeat_unbounded',
        error:
          'workflow step 0: a repeat may run at most 16 iterations, nested repeats multiplied (got 17)',
      });
      expect(h.submitWorkflow).not.toHaveBeenCalled();

      // 16 is allowed, and the whatif carries the loop AND the list it iterates,
      // so the orchestrator prices every child.
      whatifCost = { total: 32, base: 32 };
      realizedCost = { total: 32, base: 32 };
      const allowed = await run(repeatOver(16));
      expect(allowed.snapshot.status).toBe('pending');
      const quoted = whatifs()[0].body;
      expect(quoted.steps).toHaveLength(1);
      expect(quoted.steps[0].$type).toBe('repeat');
      expect((quoted.arguments as { images: unknown[] }).images).toHaveLength(16);
    }
  );

  it.each(paths)('%s: a reference to a LATER step is `workflow_ref_invalid`', async (_n, run) => {
    const { snapshot } = await run(
      body({
        steps: [
          {
            $type: 'imageUpscaler',
            input: { image: { $ref: 'gen', path: 'output.images[0].url' } },
          },
          { name: 'gen', $type: 'imageGen', input: GEN_INPUT },
        ],
      })
    );
    expect(snapshot).toEqual({
      workflowId: 'failed',
      status: 'failed',
      errorCode: 'workflow_ref_invalid',
      error: 'workflow step 0: "$ref": "gen" does not name "$arguments" or an earlier step',
    });
    expect(h.getOrchestratorToken).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter(USER_CAP)).toBe(0);
  });

  it.each(paths)('%s: nine steps is `workflow_too_many_steps`', async (_n, run) => {
    const { snapshot } = await run(
      body({ steps: Array.from({ length: 9 }, () => ({ $type: 'echo', input: {} })) })
    );
    expect(snapshot).toEqual({
      workflowId: 'failed',
      status: 'failed',
      errorCode: 'workflow_too_many_steps',
      error: 'a workflow may have at most 8 steps (got 9)',
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each(paths)('%s: a MODEL token is refused like the pass-through arm', async (_n, run) => {
    h.authorize.mockImplementation(async () =>
      claims({ ctx: { slotId: 'model.sidebar_top', entityType: 'model', modelId: 5 } })
    );
    await expect(run()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'registry steps are page-only',
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' SUBMIT — the money path", () => {
  const paths = [
    ['estimate', estimate],
    ['submit', submit],
  ] as const;

  it('🔴 reserves quote + fee ONCE, under a ceiling of budget × steps', async () => {
    // 64 is above ONE per-generation budget (37): a ceiling that forgot the step
    // multiplier would refuse this.
    const { snapshot } = await submit();
    expect(snapshot.workflowId).toBe(WORKFLOW_ID);
    expect(snapshot.status).toBe('pending');
    // The reply's total is the realized generation cost — no fee added.
    expect(snapshot.cost).toEqual({ total: 64 });

    expect(counter(USER_CAP)).toBe(QUOTE + FEE);
    expect(h.reserveAppSpend).toHaveBeenCalledTimes(1);
    expect(whatifs()).toHaveLength(1);
    expect(realSubmits()).toHaveLength(1);
  });

  it('🔴 counts ONE velocity unit PER STEP on the per-app cap', async () => {
    await submit();
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', QUOTE + FEE, { units: STEPS });

    // One step: the ceiling is one budget, so the quote has to fit under 37.
    h.reserveAppSpend.mockClear();
    whatifCost = { total: 20, base: 20 };
    await submit(body({ steps: [{ $type: 'echo', input: {} }], arguments: undefined }));
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', 21, { units: 1 });
  });

  it('submits the SAME step objects the quote priced, with the name record and no timeout', async () => {
    await submit(body(), 'idem-key-0001');
    expect(idemKeys()).toHaveLength(1);
    const quoted = whatifs()[0].body;
    const sent = realSubmits()[0].body;
    expect(sent.steps).toHaveLength(STEPS);
    sent.steps.forEach((step, i) => {
      expect(step).toBe(quoted.steps[i]);
      expect('timeout' in step).toBe(false);
    });
    expect(sent.steps.map((s) => s.name)).toEqual(['gen', '$1', '$2']);
    expect(sent.tags).toEqual(quoted.tags);
    expect(sent.arguments).toEqual({ strength: 0.4 });
    expect(sent.allowMatureContent).toBe(false);
    expect(sent.externalId).toMatch(/^blk/);
    // Which steps this submit named — the list a later poll gates on.
    expect(sent.metadata).toEqual({
      blockWorkflowSteps: [{ name: 'gen' }, { name: '$1', suppressOutput: true }, { name: '$2' }],
    });
  });

  describe('the resources a step names', () => {
    const naming = (model: string) =>
      body({ steps: [{ $type: 'echo', input: { model } }], arguments: undefined });

    beforeEach(() => {
      // Under one step's budget.
      whatifCost = { total: 20, base: 20 };
      h.authorize.mockImplementation(async () => claims({ maxBrowsingLevel: 31 }));
      dbMock.dbRead.modelVersion.findMany.mockImplementation((async (args: {
        where: { id: { in: number[] } };
      }) =>
        args.where.id.in.map((id) => ({
          id,
          baseModel: id === 11 ? 'SDXL Turbo' : 'SDXL 1.0',
        }))) as never);
    });

    it('holds the output to PG-13 when one is on a base model that restricts mature generation', async () => {
      await submit(naming('urn:air:sdxl:checkpoint:civitai:1@11'));
      expect(realSubmits()[0].body).toMatchObject({ nsfwLevel: 'pg13', allowMatureContent: false });
    });

    it('leaves a mature ceiling alone for an unrestricted base model', async () => {
      await submit(naming('urn:air:sdxl:checkpoint:civitai:1@10'));
      expect(realSubmits()[0].body.nsfwLevel).toBeUndefined();
      expect(realSubmits()[0].body.allowMatureContent).not.toBe(false);
    });

    it.each(paths)(
      '%s refuses a Hugging Face resource before any orchestrator call',
      async (_, run) => {
        await expect(
          run(naming('urn:air:sdxl:checkpoint:huggingface:org/repo@main/x.safetensors'))
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(whatifs()).toHaveLength(0);
        expect(realSubmits()).toHaveLength(0);
      }
    );
  });

  it('🔴 the fee is ONE resolved value: estimate = reservation = charge, under one type', async () => {
    const shown = (await estimate()).snapshot.cost?.authorFee;
    expect(shown).toBe(FEE);

    realizedCost = { total: 64, base: 60 };
    await submit();

    expect(h.chargeAuthorFee).toHaveBeenCalledTimes(1);
    expect(h.chargeAuthorFee).toHaveBeenCalledWith({
      workflowId: WORKFLOW_ID,
      appId: 'app_test',
      appBlockId: 'apb_test',
      viewerUserId: VIEWER,
      buzzType: 'blue',
      baseGenerationBuzz: 60,
      priceIsCap: false,
      generationType: 'workflow',
      reservedAuthorFeeBuzz: shown,
      privateRun: false,
    });
    // Fire-and-forget behind a dynamic import, so it lands after the reply.
    await vi.waitFor(() =>
      expect(h.recordSpendAttribution).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: WORKFLOW_ID,
          generationType: 'workflow',
          baseGenerationBuzz: 60,
          generationPriceIsCap: false,
          buzzAmount: 64,
          modelId: null,
        })
      )
    );
  });

  it('🔴 when the workflow bills a HIGHER base than it was quoted, the fee stays the quoted one', async () => {
    // Quoted: total 86, base 80 → fee 4. Realized: total 251, base 240 → a fee of
    // 12 on that base. Every number here is distinct from every other.
    whatifCost = { total: 86, base: 80 };
    realizedCost = { total: 251, base: 240 };

    // 1. The estimate discloses the fee on the QUOTED base.
    expect((await estimate()).snapshot.cost).toEqual({ total: 90, authorFee: 4 });

    await submit();
    // 2. The reservation holds the quote plus that same fee.
    expect(counter(USER_CAP)).toBe(90);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', 90, { units: STEPS });
    // 3. The charge is handed the REALIZED base and the QUOTED fee as its ceiling,
    //    so what is debited is the smaller of the two fees: 4.
    expect(h.chargeAuthorFee).toHaveBeenCalledWith(
      expect.objectContaining({ baseGenerationBuzz: 240, reservedAuthorFeeBuzz: 4 })
    );
    // The attribution row records the realized base and total.
    await vi.waitFor(() =>
      expect(h.recordSpendAttribution).toHaveBeenCalledWith(
        expect.objectContaining({ baseGenerationBuzz: 240, buzzAmount: 251 })
      )
    );
    // The settle is taken against the quoted generation price, not the fee.
    expect(h.persistSettle).toHaveBeenCalledWith(expect.objectContaining({ ceiling: 86 }));
  });

  it('🔴 a SELF-DEALING author: no fee charged, and attribution gets the same inputs as every other path', async () => {
    // The viewer owns the app: the fee quote declines, so nothing is reserved for
    // a fee — but the attribution row still OBSERVES the fee on the billed base.
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ id: 'app_test', userId: VIEWER });
    whatifCost = { total: 86, base: 80 };
    realizedCost = { total: 86, base: 80 };
    expect((await estimate()).snapshot.cost).toEqual({ total: 86, authorFee: 0 });
    await submit();
    expect(counter(USER_CAP)).toBe(86);
    expect(h.chargeAuthorFee).toHaveBeenCalledWith(
      expect.objectContaining({ reservedAuthorFeeBuzz: 0, baseGenerationBuzz: 80 })
    );
    await vi.waitFor(() => expect(h.recordSpendAttribution).toHaveBeenCalledTimes(1));
    // Exactly the input set the registered-step path passes: the billed base and
    // cap flag, and no fee ceiling — so the observed fee is computed on 80, not 0.
    expect(h.recordSpendAttribution).toHaveBeenCalledWith({
      userId: VIEWER,
      buzzAmount: 86,
      buzzType: 'blue',
      workflowId: WORKFLOW_ID,
      appId: 'app_test',
      appBlockId: 'apb_test',
      blockInstanceId: 'page_apb_test',
      privateRun: false,
      modelId: null,
      sharedContentKey: null,
      generationType: 'workflow',
      baseGenerationBuzz: 80,
      generationPriceIsCap: false,
    });
  });

  it('prices the fee off the whatif `cost.base`, never `cost.total`', async () => {
    // total 12 and base 100 disagree: a fee on `total` would be the flat 1.
    whatifCost = { total: 12, base: 100 };
    realizedCost = { total: 12, base: 100 };
    expect((await estimate()).snapshot.cost).toEqual({ total: 17, authorFee: 5 });
    await submit();
    expect(counter(USER_CAP)).toBe(17);
    expect(h.chargeAuthorFee).toHaveBeenCalledWith(
      expect.objectContaining({ reservedAuthorFeeBuzz: 5, baseGenerationBuzz: 100 })
    );
  });

  it('settles against the GENERATION leg and asks for the overage correction', async () => {
    await submit();
    expect(h.persistSettle).toHaveBeenCalledTimes(1);
    expect(h.persistSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: WORKFLOW_ID,
        // 64, not 67: the fee leg is charged at exactly what was reserved.
        ceiling: QUOTE,
        correctOverage: true,
        appSpendKey: 'app-daily',
        engine: 'multistep',
        recipe: '__workflow__',
      })
    );
  });

  it('records every reservation key on the settle record', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      buzzBudgetPerDay: 5000,
      revokedAt: null,
    });
    h.getActiveDevTunnel.mockImplementation(async () => ({
      sessionId: 'bki_1',
      spendCapBuzz: 500,
    }));
    h.reserveDevSessionBuzz.mockImplementation(async () => ({ allowed: true, total: 67 }));
    await submit();
    const [capKey] = keysWith(USER_CAP);
    const [consentKey] = keysWith(CONSENT_BUDGET);
    expect(capKey).toBeDefined();
    expect(consentKey).toBeDefined();
    // Both legs hold the same reservation.
    expect(Number(store.get(consentKey))).toBe(QUOTE + FEE);
    expect(h.persistSettle).toHaveBeenCalledWith({
      workflowId: WORKFLOW_ID,
      buzzCapKey: capKey,
      consentBudgetKey: consentKey,
      appSpendKey: 'app-daily',
      devSessionId: 'bki_1',
      ceiling: QUOTE,
      engine: 'multistep',
      recipe: '__workflow__',
      submittedAt: expect.any(Number),
      correctOverage: true,
    });
  });

  it('a DEV token skips the per-app cap and still reserves the per-user one', async () => {
    h.authorize.mockImplementation(async () => claims({ dev: true }));
    const { snapshot } = await submit();
    expect(snapshot.workflowId).toBe(WORKFLOW_ID);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
    expect(counter(USER_CAP)).toBe(QUOTE + FEE);
    expect(h.persistSettle).toHaveBeenCalledWith(expect.objectContaining({ appSpendKey: null }));
  });

  it('🔴 a submit the orchestrator answers as FAILED charges no fee and writes no attribution', async () => {
    h.submitWorkflow.mockImplementation(async (args: SubmitArgs) =>
      args.query?.whatif
        ? { id: 'whatif-id', status: 'scheduled', cost: whatifCost }
        : { id: WORKFLOW_ID, status: 'failed', cost: { total: 9, base: 9 }, steps: [] }
    );
    const { snapshot } = await submit();
    expect(snapshot.status).toBe('failed');
    await vi.waitFor(() =>
      expect(h.recordScopeInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          detail: expect.objectContaining({ outcome: 'failed', amount: -9 }),
        })
      )
    );
    expect(h.chargeAuthorFee).not.toHaveBeenCalled();
    expect(h.recordSpendAttribution).not.toHaveBeenCalled();
  });

  it('writes the audit row with every step `$type` and the workflow variant', async () => {
    await submit();
    await vi.waitFor(() =>
      expect(h.recordScopeInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'ai:write:budgeted',
          endpoint: 'workflow:submit',
          statusCode: 200,
          detail: {
            action: 'workflow.submit',
            amount: -64,
            outcome: 'ok',
            steps: ['imageGen', 'imageUpscaler', 'transcode'],
            variant: 'workflow',
            workflowId: WORKFLOW_ID,
          },
        })
      )
    );
  });

  it('🔴 refuses a workflow whose quote + fee is OVER budget × steps, quoting the price', async () => {
    // 110 alone fits under 111; the fee (5% of 100) is what puts it over. And
    // 115 is under FOUR budgets (148), so a ceiling one step too generous passes it.
    whatifCost = { total: 110, base: 100 };
    const { snapshot } = await submit();
    expect(snapshot).toEqual({
      workflowId: 'failed',
      status: 'failed',
      cost: { total: 115, authorFee: 5 },
      error: 'insufficient buzz budget: workflow price 115 exceeds budget 111 (3 steps at 37 each)',
    });
    expect(realSubmits()).toHaveLength(0);
    expect(counter(USER_CAP)).toBe(0);
    expect(idemKeys()).toEqual([]);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
    expect(h.chargeAuthorFee).not.toHaveBeenCalled();
  });

  it('allows the same quote when the fee is not charged (it was the fee that was over)', async () => {
    whatifCost = { total: 110, base: 100 };
    realizedCost = { total: 110, base: 100 };
    h.authorFeeFlag.mockImplementation(async () => false);
    const { snapshot } = await submit();
    expect(snapshot.workflowId).toBe(WORKFLOW_ID);
    expect(counter(USER_CAP)).toBe(110);
  });

  it('the ceiling scales with the step count: the same quote is refused for two steps', async () => {
    // 90 + a fee of 1 sits between two budgets (74) and three (111).
    whatifCost = { total: 90, base: 20 };
    const two = body({ steps: body().steps.slice(0, 2) });
    const refused = await submit(two);
    expect(refused.snapshot.error).toBe(
      'insufficient buzz budget: workflow price 91 exceeds budget 74 (2 steps at 37 each)'
    );
    realizedCost = { total: 90, base: 20 };
    const allowed = await submit();
    expect(allowed.snapshot.workflowId).toBe(WORKFLOW_ID);
  });

  // One multi-step call is bounded at 8000 Buzz in total whatever the budget. Budgets
  // here overshoot that bound without their ceiling being a multiple of it: 1301 x 8 is
  // 10408 and 5000 x 8 is 40000 (the per-call cap), 5000 x 2 is 10000.
  describe('the 8000 Buzz bound on one multi-step call', () => {
    const stepsOf = (n: number) =>
      body({
        steps: Array.from({ length: n }, () => ({ $type: 'echo', input: {} })),
        arguments: undefined,
      });
    const withBudget = (buzzBudget: number) =>
      h.authorize.mockImplementation(async () => claims({ buzzBudget }));
    const unquoted = () => {
      whatifError = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'upstream down' });
      annotateOrchestratorSubmitFailure(whatifError, { status: 503, attempt: 3 });
      realizedCost = { total: 20, base: 20 };
    };
    const noFee = () => h.authorFeeFlag.mockImplementation(async () => false);

    it.each([
      // budget, steps, reserved, per-step timeout (seconds)
      [5000, 8, 8000, 1000],
      [1301, 8, 8000, 1000],
      [5000, 2, 8000, 4000],
      [5000, 3, 8000, 2666],
    ])(
      'an unquoted call at budget %i x %i steps reserves %i, and each step times out at %is',
      async (budget, steps, reserved, timeout) => {
        withBudget(budget);
        unquoted();
        const { snapshot } = await submit(stepsOf(steps));
        expect(snapshot.workflowId).toBe(WORKFLOW_ID);
        expect(counter(USER_CAP)).toBe(reserved);
        const sent = realSubmits()[0].body.steps;
        expect(sent).toHaveLength(steps);
        for (const step of sent) expect(step.timeout).toBe(formatStepTimeout(timeout));
      }
    );

    it.each([
      // Under the bound the ceiling is still budget x steps, and the timeout the budget.
      [1000, 8, 8000, 1000],
      [5000, 1, 5000, 5000],
      [999, 8, 7992, 999],
    ])(
      'an unquoted call at budget %i x %i steps reserves %i (the bound does not bind) [INV]',
      async (budget, steps, reserved, timeout) => {
        withBudget(budget);
        unquoted();
        await submit(stepsOf(steps));
        expect(counter(USER_CAP)).toBe(reserved);
        expect(realSubmits()[0].body.steps).toHaveLength(steps);
        for (const step of realSubmits()[0].body.steps) {
          expect(step.timeout).toBe(formatStepTimeout(timeout));
        }
      }
    );

    it.each([[8001], [9301], [39999]])(
      'a call priced at %i is refused, naming the 8000 limit, at budget 5000 x 8 steps',
      async (total) => {
        withBudget(5000);
        noFee();
        whatifCost = { total, base: total };
        const { snapshot } = await submit(stepsOf(8));
        expect(snapshot).toEqual({
          workflowId: 'failed',
          status: 'failed',
          cost: { total, authorFee: 0 },
          error: `insufficient buzz budget: workflow price ${total} exceeds the limit of 8000 Buzz for one multi-step call`,
        });
        expect(realSubmits()).toHaveLength(0);
        expect(counter(USER_CAP)).toBe(0);
        expect(h.reserveAppSpend).not.toHaveBeenCalled();
      }
    );

    it('a call priced at exactly 8000 is accepted at budget 5000 x 8 steps [INV]', async () => {
      withBudget(5000);
      noFee();
      whatifCost = { total: 8000, base: 8000 };
      realizedCost = { total: 8000, base: 8000 };
      const { snapshot } = await submit(stepsOf(8));
      expect(snapshot.workflowId).toBe(WORKFLOW_ID);
      expect(counter(USER_CAP)).toBe(8000);
    });

    it('the author fee counts toward the 8000: 7900 + a 5% fee is refused', async () => {
      withBudget(5000);
      whatifCost = { total: 7900, base: 7900 };
      const { snapshot } = await submit(stepsOf(8));
      expect(snapshot.cost).toEqual({ total: 8295, authorFee: 395 });
      expect(snapshot.error).toBe(
        'insufficient buzz budget: workflow price 8295 exceeds the limit of 8000 Buzz for one multi-step call'
      );
    });

    it('a one-step call is held to its budget, not to the 8000 limit [INV]', async () => {
      withBudget(5000);
      noFee();
      whatifCost = { total: 5001, base: 5001 };
      const refused = await submit(stepsOf(1));
      expect(refused.snapshot.error).toBe(
        'insufficient buzz budget: workflow price 5001 exceeds budget 5000 (1 steps at 5000 each)'
      );
      whatifCost = { total: 5000, base: 5000 };
      realizedCost = { total: 5000, base: 5000 };
      const allowed = await submit(stepsOf(1));
      expect(allowed.snapshot.workflowId).toBe(WORKFLOW_ID);
    });

    // budget x steps is exactly the limit: the limit does not bind, so the budget is named.
    it('at budget 1000 x 8 steps a call priced at 8001 is refused by the budget [INV]', async () => {
      withBudget(1000);
      noFee();
      whatifCost = { total: 8001, base: 8001 };
      const { snapshot } = await submit(stepsOf(8));
      expect(snapshot.error).toBe(
        'insufficient buzz budget: workflow price 8001 exceeds budget 8000 (8 steps at 1000 each)'
      );
    });

    it('under the bound the refusal still names the budget [INV]', async () => {
      withBudget(999);
      noFee();
      whatifCost = { total: 7993, base: 7993 };
      const { snapshot } = await submit(stepsOf(8));
      expect(snapshot.error).toBe(
        'insufficient buzz budget: workflow price 7993 exceeds budget 7992 (8 steps at 999 each)'
      );
    });
  });

  it('🔴 an UNQUOTED workflow proceeds, reserved at the ceiling, with no fee', async () => {
    whatifError = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'upstream down' });
    annotateOrchestratorSubmitFailure(whatifError, { status: 503, attempt: 3 });
    realizedCost = { total: 20, base: 20 };
    const { snapshot } = await submit();
    expect(snapshot.workflowId).toBe(WORKFLOW_ID);

    expect(counter(USER_CAP)).toBe(CEILING);
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', CEILING, { units: STEPS });
    expect(h.persistSettle).toHaveBeenCalledWith(
      expect.objectContaining({ ceiling: CEILING, correctOverage: true })
    );
    // No quote, so no base to price a fee from: nothing reserved for one.
    expect(h.chargeAuthorFee).toHaveBeenCalledWith(
      expect.objectContaining({ reservedAuthorFeeBuzz: 0 })
    );
    // Each step is stamped the per-step budget as its timeout, as the
    // pass-through arm stamps its one step.
    for (const step of realSubmits()[0].body.steps) {
      expect(step.timeout).toBe(formatStepTimeout(BUDGET));
    }
  });

  it.each(QUOTE_FAILURES)(
    '🔴 no quote ($name) does not refuse the submit: it proceeds at the ceiling the estimate will not show',
    async ({ arrange, errorCode }) => {
      arrange();
      expect((await estimate()).snapshot).toMatchObject({ status: 'failed', errorCode });
      realizedCost = { total: 20, base: 20 };
      const { snapshot } = await submit();
      expect(snapshot.workflowId).toBe(WORKFLOW_ID);
      expect(snapshot.errorCode).toBeUndefined();
      expect(counter(USER_CAP)).toBe(CEILING);
      expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', CEILING, { units: STEPS });
    }
  );

  const repeatBody = () =>
    body({
      arguments: { images: [{ url: 'a' }] },
      steps: [
        { $type: 'echo', input: {} },
        {
          $type: 'repeat',
          input: {
            for: { $ref: '$arguments', path: 'images', as: 'image' },
            template: { $type: 'wdTagging', input: {} },
          },
        },
      ],
    });
  it.each(
    paths.flatMap(([path, run]) => QUOTE_FAILURES.map((failure) => ({ path, run, ...failure })))
  )(
    '$path: the unpriced-`repeat` refusal names the cause ($name) and keeps its code',
    async ({ run, arrange, cause }) => {
      arrange();
      const { snapshot } = await run(repeatBody());
      expect(snapshot).toEqual({
        workflowId: 'failed',
        status: 'failed',
        errorCode: 'workflow_repeat_unbounded',
        error: `workflow step 1: a workflow with a repeat needs a price quote and ${cause}`,
      });
      expect(realSubmits()).toHaveLength(0);
      expect(counter(USER_CAP)).toBe(0);
    }
  );

  it.each(paths)(
    '🔴 %s: an UNPRICED workflow with a `repeat` is refused before any reservation',
    async (_n, run) => {
      whatifCost = undefined;
      const repeatStep = (template: Record<string, unknown>) => ({
        $type: 'repeat',
        input: { for: { $ref: '$arguments', path: 'images', as: 'image' }, template },
      });
      for (const steps of [
        [{ $type: 'echo', input: {} }, repeatStep({ $type: 'wdTagging', input: {} })],
        [
          repeatStep({
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'tiles', as: 'tile' },
              template: { $type: 'wdTagging', input: {} },
            },
          }),
        ],
      ]) {
        const { snapshot } = await run(
          body({ steps, arguments: { images: [{ url: 'a' }], tiles: [1] } })
        );
        expect(snapshot).toEqual({
          workflowId: 'failed',
          status: 'failed',
          errorCode: 'workflow_repeat_unbounded',
          error: `workflow step ${
            steps.length - 1
          }: a workflow with a repeat needs a price quote and the orchestrator answered without one`,
        });
      }
      expect(realSubmits()).toHaveLength(0);
      expect(counter(USER_CAP)).toBe(0);
      expect(h.reserveAppSpend).not.toHaveBeenCalled();
    }
  );

  it('🔴 the unpriced-repeat refusal takes the idempotency claim and RELEASES it', async () => {
    whatifCost = undefined;
    const sets = redisMock.sysRedis.set.mock.calls.length;
    const { snapshot } = await submit(
      body({
        arguments: { images: [{ url: 'a' }] },
        steps: [
          {
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'images', as: 'image' },
              template: { $type: 'wdTagging', input: {} },
            },
          },
        ],
      }),
      'idem-key-0020'
    );
    expect(snapshot.errorCode).toBe('workflow_repeat_unbounded');
    // The claim was taken…
    expect(
      redisMock.sysRedis.set.mock.calls
        .slice(sets)
        .some(([key]) => String(key).endsWith(':apb_test:idem-key-0020'))
    ).toBe(true);
    // …and released, so a retry with the same key can run once a quote exists.
    expect(idemKeys()).toEqual([]);
    expect(realSubmits()).toHaveLength(0);
  });

  it('🔴 a nested repeat counts 3 × 5 = 15 generations against the velocity ceiling (+2 plain steps)', async () => {
    whatifCost = { total: 70, base: 70 };
    realizedCost = { total: 70, base: 70 };
    await submit(
      body({
        arguments: { images: [1, 2, 3], tiles: [1, 2, 3, 4, 5] },
        steps: [
          {
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'images', as: 'image' },
              template: {
                $type: 'repeat',
                input: {
                  for: { $ref: '$arguments', path: 'tiles', as: 'tile' },
                  template: { $type: 'wdTagging', input: {} },
                },
              },
            },
          },
          { $type: 'echo', input: {} },
          { $type: 'echo', input: {} },
        ],
      })
    );
    // 15 from the loop + 2 plain steps; 70 + fee 3 (5% of 70).
    expect(h.reserveAppSpend).toHaveBeenCalledWith('apb_test', 73, { units: 17 });
  });

  it('with a quote, a `repeat` input is forwarded as the same object, unstamped', async () => {
    whatifCost = { total: 20, base: 20 };
    await submit(
      body({
        steps: [
          {
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'images', as: 'image' },
              template: { $type: 'wdTagging', input: {} },
            },
          },
        ],
        arguments: { images: [{ url: 'a' }] },
      })
    );
    const [sent] = realSubmits()[0].body.steps;
    expect(sent.input).toBe(whatifs()[0].body.steps[0].input);
    expect(JSON.stringify(sent)).not.toContain('timeout');
  });

  it('an unpriced answer (no finite total) is the same no-quote path', async () => {
    whatifCost = { base: 60 };
    await submit();
    expect(counter(USER_CAP)).toBe(CEILING);
  });

  it('refuses everything when the per-generation budget is zero, quoted or not', async () => {
    // An editor's private run: `blockPerCallBudget` answers 0.
    h.authorize.mockImplementation(async () =>
      claims({ privateRun: true, privateRunAudience: 'editor' })
    );
    whatifCost = undefined;
    const unquoted = await submit();
    expect(unquoted.snapshot.status).toBe('failed');
    expect(unquoted.snapshot.error).toContain('exceeds budget 0 (3 steps at 0 each)');
    expect(realSubmits()).toHaveLength(0);
    expect(counter(USER_CAP)).toBe(0);
  });

  it('refuses an unquoted workflow that runs a TRAINING step, and releases the key', async () => {
    whatifCost = undefined;
    const { snapshot } = await submit(
      body({
        steps: [
          { $type: 'echo', input: {} },
          { $type: 'training', input: {} },
        ],
      }),
      'idem-key-0002'
    );
    expect(snapshot.status).toBe('failed');
    expect(snapshot.errorCode).toBe('training-quote-unpriced');
    expect(realSubmits()).toHaveLength(0);
    expect(counter(USER_CAP)).toBe(0);
    expect(idemKeys()).toEqual([]);
  });

  it('tags a workflow that runs a training step for the training surfaces', async () => {
    whatifCost = { total: 20, base: 20 };
    await submit(body({ steps: [{ $type: 'training', input: {} }] }));
    expect(realSubmits()[0].body.tags).toContain(TRAINING_WORKFLOW_TAG);
    // …including one a `repeat` runs.
    h.submitWorkflow.mockClear();
    await submit(
      body({
        arguments: { sets: ['one'] },
        steps: [
          {
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'sets', as: 'set' },
              template: { $type: 'training', input: {} },
            },
          },
        ],
      })
    );
    expect(realSubmits()[0].body.tags).toContain(TRAINING_WORKFLOW_TAG);
    whatifCost = { total: 64, base: 60 };
    h.submitWorkflow.mockClear();
    await submit();
    expect(realSubmits()[0].body.tags).not.toContain(TRAINING_WORKFLOW_TAG);
  });

  it('matches a training step type case-insensitively, consistent with the denylist', async () => {
    // Tagged when quoted…
    whatifCost = { total: 20, base: 20 };
    await submit(body({ steps: [{ $type: 'Training', input: {} }] }));
    expect(realSubmits()[0].body.tags).toContain(TRAINING_WORKFLOW_TAG);
    // …and refused when not.
    h.submitWorkflow.mockClear();
    whatifCost = undefined;
    const { snapshot } = await submit(
      body({
        steps: [
          { $type: 'echo', input: {} },
          { $type: 'TRAINING', input: {} },
        ],
      })
    );
    expect(snapshot.status).toBe('failed');
    expect(snapshot.errorCode).toBe('training-quote-unpriced');
    expect(realSubmits()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' SUBMIT — refusals after the gate refund every key", () => {
  it('the per-user daily cap refuses with the priced reply and reserves nothing', async () => {
    // One submit to learn the day's counter key, then put it far over any cap.
    await submit();
    const [capKey] = keysWith(USER_CAP);
    store.set(capKey, String(10_000_000));
    h.reserveAppSpend.mockClear();
    const { snapshot } = await submit(body(), 'idem-key-0010');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.cost).toEqual({ total: QUOTE + FEE, authorFee: FEE });
    expect(snapshot.error).toMatch(
      /^daily Buzz cap reached: 10000000 already spent today across your installed apps, this workflow may cost up to 67, daily cap is \d+$/
    );
    expect(Number(store.get(capKey))).toBe(10_000_000);
    expect(idemKeys()).toEqual([]);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
    expect(realSubmits()).toHaveLength(1);
  });

  it("the viewer's CONSENT budget refuses on its own, refunding both legs", async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      // Under the 67 this workflow reserves; the platform daily cap is far above it.
      buzzBudgetPerDay: 50,
      revokedAt: null,
    });
    const { snapshot } = await submit(body(), 'idem-key-0011');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.cost).toEqual({ total: QUOTE + FEE, authorFee: FEE });
    expect(snapshot.error).toContain('this workflow may cost up to 67');
    expect(snapshot.error).not.toContain('daily Buzz cap reached');
    expect(counter(USER_CAP)).toBe(0);
    expect(counter(CONSENT_BUDGET)).toBe(0);
    expect(idemKeys()).toEqual([]);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
    expect(realSubmits()).toHaveLength(0);
  });

  it('a reservation that THROWS releases the idempotency claim', async () => {
    redisMock.sysRedis.incrBy.mockClear();
    redisMock.sysRedis.incrBy.mockRejectedValueOnce(new Error('redis down'));
    await expect(submit(body(), 'idem-key-0012')).rejects.toBeTruthy();
    // It was the reservation that threw: the quote ran, and nothing after it did.
    expect(whatifs()).toHaveLength(1);
    expect(redisMock.sysRedis.incrBy).toHaveBeenCalledTimes(1);
    expect(h.reserveAppSpend).not.toHaveBeenCalled();
    expect(idemKeys()).toEqual([]);
    expect(realSubmits()).toHaveLength(0);
  });

  it('the per-app cap refuses with the priced reply and refunds the per-user leg', async () => {
    h.reserveAppSpend.mockImplementation(async () => ({ allowed: false, reason: 'velocity' }));
    const { snapshot } = await submit(body(), 'idem-key-0003');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.cost).toEqual({ total: QUOTE + FEE, authorFee: FEE });
    expect(snapshot.error).toContain('app generation rate limit reached');
    expect(counter(USER_CAP)).toBe(0);
    expect(idemKeys()).toEqual([]);
    expect(realSubmits()).toHaveLength(0);
  });

  it('the dev-tunnel backstop refuses and refunds the per-user and per-app legs', async () => {
    h.getActiveDevTunnel.mockImplementation(async () => ({ sessionId: 'bki_1', spendCapBuzz: 50 }));
    h.reserveDevSessionBuzz.mockImplementation(async () => ({ allowed: false, total: 41 }));
    const { snapshot } = await submit(body(), 'idem-key-0013');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.cost).toEqual({ total: QUOTE + FEE, authorFee: FEE });
    expect(h.reserveDevSessionBuzz).toHaveBeenCalledWith('bki_1', QUOTE + FEE, 50);
    expect(counter(USER_CAP)).toBe(0);
    expect(h.refundAppSpend).toHaveBeenCalledWith('app-daily', QUOTE + FEE);
    expect(idemKeys()).toEqual([]);
    expect(realSubmits()).toHaveLength(0);
  });

  it('a submit that throws refunds every key and charges no fee', async () => {
    h.getActiveDevTunnel.mockImplementation(async () => ({
      sessionId: 'bki_1',
      spendCapBuzz: 500,
    }));
    h.reserveDevSessionBuzz.mockImplementation(async () => ({ allowed: true, total: 67 }));
    submitError = throwBadRequestErrorValue();
    await expect(submit(body(), 'idem-key-0004')).rejects.toBeInstanceOf(TRPCError);
    expect(counter(USER_CAP)).toBe(0);
    expect(h.refundAppSpend).toHaveBeenCalledWith('app-daily', QUOTE + FEE);
    expect(h.refundDevSessionBuzz).toHaveBeenCalledWith('bki_1', QUOTE + FEE);
    expect(idemKeys()).toEqual([]);
    expect(h.chargeAuthorFee).not.toHaveBeenCalled();
    expect(h.persistSettle).not.toHaveBeenCalled();
  });
});

function throwBadRequestErrorValue(): unknown {
  try {
    throwBadRequestError('orchestrator refused the workflow');
  } catch (e) {
    return e;
  }
  return new Error('unreachable');
}

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' SUBMIT — idempotency", () => {
  it('🔴 a same-key resubmit replays the first result: one reservation, one charge', async () => {
    const first = await submit(body(), 'idem-key-0005');
    const second = await submit(body(), 'idem-key-0005');
    expect(second).toEqual(first);
    expect(realSubmits()).toHaveLength(1);
    expect(counter(USER_CAP)).toBe(QUOTE + FEE);
    expect(h.reserveAppSpend).toHaveBeenCalledTimes(1);
    expect(h.chargeAuthorFee).toHaveBeenCalledTimes(1);
  });

  it('🔴 a same-key submit that is still IN FLIGHT is a CONFLICT, and reserves nothing', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.reserveAppSpend.mockImplementationOnce(async () => {
      await held;
      return { allowed: true, dailyKey: 'app-daily' };
    });
    const first = submit(body(), 'idem-key-0008');
    await vi.waitFor(() => expect(h.reserveAppSpend).toHaveBeenCalledTimes(1));

    await expect(submit(body(), 'idem-key-0008')).rejects.toMatchObject({ code: 'CONFLICT' });
    // Only the first submit's reservation exists.
    expect(counter(USER_CAP)).toBe(QUOTE + FEE);
    expect(h.reserveAppSpend).toHaveBeenCalledTimes(1);

    release();
    expect((await first).snapshot.workflowId).toBe(WORKFLOW_ID);
    expect(realSubmits()).toHaveLength(1);
  });

  it('a different key is a different workflow', async () => {
    await submit(body(), 'idem-key-0006');
    await submit(body(), 'idem-key-0007');
    expect(realSubmits()).toHaveLength(2);
    expect(realSubmits()[0].body.externalId).not.toBe(realSubmits()[1].body.externalId);
    expect(counter(USER_CAP)).toBe(2 * (QUOTE + FEE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' in a BATCH estimate", () => {
  it('prices a workflow cell as ONE cell and fails a refused one on its own', async () => {
    const result = await caller().estimateWorkflowBatch({
      blockToken: 't',
      bodies: [
        body(),
        body({
          steps: [
            { $type: 'echo', input: {} },
            { $type: 'modelHash', input: {} },
          ],
        }),
        { kind: 'workflow', steps: [] },
        body({
          steps: [
            { name: 'frames', $type: 'videoFrameExtraction', input: {} },
            {
              $type: 'repeat',
              input: {
                for: { $ref: 'frames', path: 'output.frames', as: 'frame' },
                template: { $type: 'wdTagging', input: {} },
              },
            },
          ],
        }),
      ],
    });
    expect(result.snapshots[3]).toMatchObject({
      status: 'failed',
      errorCode: 'workflow_repeat_unbounded',
    });
    expect((result.snapshots[3] as Snap).error).toContain('workflow step 1: a repeat may only');
    expect(result.snapshots[0]).toEqual({
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: QUOTE + FEE, authorFee: FEE },
    });
    expect(result.snapshots[1]).toMatchObject({
      status: 'failed',
      errorCode: 'workflow_step_denied',
    });
    expect((result.snapshots[1] as Snap).error).toContain('workflow step 1');
    // A body the wire schema refuses is that cell's failure, with no code.
    expect(result.snapshots[2].status).toBe('failed');
    expect(result.snapshots[2].errorCode).toBeUndefined();
    expect(result.aggregate).toEqual({ total: QUOTE + FEE, pricedCells: 1, cellCount: 4 });
    // One whatif for the one cell that got as far as pricing.
    expect(whatifs()).toHaveLength(1);
    expect(realSubmits()).toHaveLength(0);
  });

  it('🔴 a cell the orchestrator will not quote fails on its own, coded, and is not summed', async () => {
    const rejected = body({ steps: [{ $type: 'echo', input: { marker: 'rejected-cell' } }] });
    h.submitWorkflow.mockImplementation(async (args: SubmitArgs) => {
      if (args.body.steps.length === 1) throw orchestratorError(400, REJECTION_REASON);
      return { id: 'whatif-id', status: 'scheduled', cost: whatifCost };
    });
    const result = await caller().estimateWorkflowBatch({
      blockToken: 't',
      bodies: [rejected, body()],
    });
    expect(result.snapshots[0]).toEqual({
      workflowId: 'failed',
      status: 'failed',
      errorCode: 'workflow_quote_rejected',
      error: `No price quote for this workflow: the orchestrator rejected the request: ${REJECTION_REASON}`,
    });
    expect(result.snapshots[1]).toEqual({
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: QUOTE + FEE, authorFee: FEE },
    });
    expect(result.aggregate).toEqual({ total: QUOTE + FEE, pricedCells: 1, cellCount: 2 });
    expect(whatifs()).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("kind:'workflow' POLL / CANCEL", () => {
  const blob = (url: string) => ({ id: url, url, available: true, type: 'image' });
  function terminalWorkflow(over: Record<string, unknown> = {}) {
    return {
      id: WORKFLOW_ID,
      status: 'failed',
      tags: ['app-block:app_test'],
      cost: { total: 41 },
      metadata: {
        blockWorkflowSteps: [{ name: 'gen' }, { name: '$1', suppressOutput: true }, { name: '$2' }],
      },
      steps: [
        {
          $type: 'imageGen',
          name: 'gen',
          status: 'succeeded',
          output: { images: [blob('https://img/gen.png')] },
        },
        {
          $type: 'imageUpscaler',
          name: '$1',
          status: 'succeeded',
          output: { blob: blob('https://img/up.png'), scale: 2 },
        },
        {
          $type: 'transcode',
          name: '$2',
          status: 'failed',
          jobs: [{ status: 'failed', reason: 'The source video could not be decoded.' }],
        },
      ],
      ...over,
    };
  }

  it('🔴 a partial failure reports per-step status, the paid cost and the usable images, and reverses the WHOLE fee', async () => {
    h.getWorkflow.mockResolvedValue(terminalWorkflow());
    const { snapshot } = (await caller().pollWorkflow({
      blockToken: 't',
      workflowId: WORKFLOW_ID,
    })) as { snapshot: Snap };

    expect(snapshot.status).toBe('failed');
    expect(snapshot.cost).toEqual({ total: 41 });
    // The suppressed step's image is in neither place.
    expect(snapshot.imageUrls).toEqual(['https://img/gen.png']);
    expect(snapshot.steps).toEqual([
      { name: 'gen', $type: 'imageGen', status: 'succeeded', imageUrls: ['https://img/gen.png'] },
      { name: '$1', $type: 'imageUpscaler', status: 'succeeded', output: { scale: 2 } },
      {
        name: '$2',
        $type: 'transcode',
        status: 'failed',
        error: 'The source video could not be decoded.',
      },
    ]);
    // Settle reads the realized total. The author fee is reversed whole for any
    // workflow that did not succeed, even though step one delivered paid output.
    expect(h.settle).toHaveBeenCalledWith({ workflowId: WORKFLOW_ID, actualCost: 41 });
    expect(h.reverseAuthorFee).toHaveBeenCalledWith({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'failed',
    });
  });

  it('cancel returns the same per-step shape and settles', async () => {
    h.getWorkflow.mockResolvedValue(terminalWorkflow({ status: 'canceled' }));
    const { snapshot } = (await caller().cancelWorkflow({
      blockToken: 't',
      workflowId: WORKFLOW_ID,
    })) as { snapshot: Snap };
    expect(h.cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(snapshot.status).toBe('canceled');
    expect(snapshot.steps).toHaveLength(3);
    expect(h.settle).toHaveBeenCalledWith({ workflowId: WORKFLOW_ID, actualCost: 41 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("pass-through arm (kind:'step') — `repeat`", () => {
  const passThrough = {
    kind: 'step' as const,
    $type: 'repeat',
    input: {
      for: { $ref: '$arguments', path: 'images', as: 'image' },
      template: { $type: 'wdTagging', input: {} },
    },
    maxBuzz: 20,
  };
  const paths = [
    ['estimate', estimate],
    ['submit', submit],
  ] as const;
  const rejection = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as TRPCError
    );

  it.each(paths)(
    '🔴 %s refuses a `repeat`: this body has no arguments for it to iterate',
    async (_n, run) => {
      const err = await rejection(run(passThrough));
      expect(err).toBeInstanceOf(TRPCError);
      expect(err?.code).toBe('BAD_REQUEST');
      expect(err?.message).toBe('repeat "for" path "images" does not name an array in "arguments"');
      expect(h.getOrchestratorToken).not.toHaveBeenCalled();
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
    }
  );

  it.each(paths)(
    '%s refuses a `repeat` over a step, with the arguments-only message',
    async (_n, run) => {
      const err = await rejection(
        run({
          ...passThrough,
          input: { ...passThrough.input, for: { $ref: '$0', path: 'o', as: 'i' } },
        })
      );
      expect(err?.code).toBe('BAD_REQUEST');
      expect(err?.message).toBe(
        'a repeat may only iterate over the workflow\'s own arguments ("$ref": "$arguments"), ' +
          'not "$0" — pass the list in "arguments" instead'
      );
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(paths)(
    '%s names the DENYLIST when the template is platform-internal',
    async (_n, run) => {
      const err = await rejection(
        run({
          ...passThrough,
          input: { ...passThrough.input, template: { $type: 'modelClamScan', input: {} } },
        })
      );
      expect(err?.code).toBe('FORBIDDEN');
      expect(err?.cause).toBeInstanceOf(PlatformInternalStepTypeError);
      expect((err?.cause as PlatformInternalStepTypeError).stepType).toBe('modelClamScan');
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
    }
  );

  it.each(paths)(
    '%s refuses a `repeat` it cannot read for certain (a re-cased template key)',
    async (_n, run) => {
      const err = await rejection(
        run({
          ...passThrough,
          input: { for: passThrough.input.for, TEMPLATE: { $type: 'modelClamScan', input: {} } },
        })
      );
      expect(err?.code).toBe('BAD_REQUEST');
      expect(err?.message).toBe(
        'a repeat step needs exactly { for: { $ref, path, as }, template: { $type, name?, input? } }, nested at most 4 deep'
      );
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );
});

describe("kind:'step' / kind:'workflow' — the generation input gate", () => {
  const OTHER_USER = 7;
  const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
  const CDN = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/original=true`;
  const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg';

  /** The image row the gate reads for KEY: owner and visibility as given. */
  function givenImage(owner: number, visible: boolean, scanComplete = true) {
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('').includes('FROM "Image" i')
        ? [
            {
              url: KEY,
              userId: owner,
              visible,
              blocked: false,
              scanComplete,
              scanPending: !scanComplete,
              held: false,
            },
          ]
        : []) as never);
  }
  afterEach(() => dbMock.dbWrite.$queryRaw.mockReset());

  const workflowWith = (url: string) => body({ arguments: { strength: 0.4, image: url } });
  const passThroughWith = (url: string) => ({
    kind: 'step' as const,
    $type: 'imageUpscaler',
    input: { image: url },
    maxBuzz: 30,
  });
  const registryWith = (url: string) => ({
    kind: 'step' as const,
    step: 'convert-image',
    params: { image: url, output: { format: 'png' } },
  });

  const ARMS = [
    ['workflow', workflowWith],
    ['pass-through step', passThroughWith],
    ['registry step', registryWith],
  ] as const;

  it.each(ARMS)(
    "%s: refuses another user's private image on estimate AND submit, before any orchestrator call",
    async (_, make) => {
      givenImage(OTHER_USER, false);
      await expect(estimate(make(CDN))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
      });
      await expect(submit(make(CDN))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
      });
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
    }
  );

  it.each(ARMS.slice(0, 2))(
    '%s: an external host is refused while the external-host flag is off',
    async (_, make) => {
      await expect(estimate(make('https://example.com/a.png'))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('hosted outside Civitai'),
      });
      expect(h.submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it.each(ARMS)(
    "POSITIVE CONTROL %s: the caller's own image and an orchestrator blob reach the orchestrator",
    async (_, make) => {
      givenImage(VIEWER, false);
      await estimate(make(CDN)).catch(() => undefined);
      expect(whatifs().length).toBeGreaterThan(0);
      h.submitWorkflow.mockClear();
      await estimate(make(BLOB)).catch(() => undefined);
      expect(whatifs().length).toBeGreaterThan(0);
    }
  );

  const hostSourcePhases = () =>
    loggingMock.logToAxiom.mock.calls
      .map(([data]) => data as Record<string, unknown>)
      .filter((data) => data.reason === 'host-orchestrator-source')
      .map((data) => data.phase);

  it.each(ARMS)(
    '%s: counts an orchestrator blob on the estimate and on the submit',
    async (_, make) => {
      loggingMock.logToAxiom.mockClear();
      await estimate(make(BLOB)).catch(() => undefined);
      await submit(make(BLOB)).catch(() => undefined);
      expect(hostSourcePhases()).toEqual(['estimate', 'submit']);
    }
  );

  const refusedBeforeTheOrchestrator = async (b: Record<string, unknown>) => {
    const refusal = { code: 'BAD_REQUEST', message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE };
    await expect(estimate(b)).rejects.toMatchObject(refusal);
    await expect(submit(b)).rejects.toMatchObject(refusal);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  };

  it.each(ARMS)(
    '%s: an own upload still being scanned is a failed snapshot with a code to retry on, before any orchestrator call',
    async (_, make) => {
      givenImage(VIEWER, false, false);
      for (const call of [estimate, submit]) {
        await expect(call(make(CDN))).resolves.toMatchObject({
          snapshot: { status: 'failed', errorCode: 'source-scan-pending' },
        });
      }
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
    }
  );

  it('an external host is allowed and counted while the app external-source refusal is off', async () => {
    flags.refuseExternalApp = false;
    await estimate(passThroughWith('https://example.com/a.png')).catch(() => undefined);
    expect(whatifs().length).toBeGreaterThan(0);
  });

  it('refuses a url with a control byte inside as unavailable, not as an external host', async () => {
    await refusedBeforeTheOrchestrator(passThroughWith('https://example.com/a\u0001.png'));
  });

  it("refuses another user's private image in a step input, not only in arguments", async () => {
    givenImage(OTHER_USER, false);
    const steps = body().steps;
    steps[1] = { ...steps[1], input: { image: CDN } };
    await refusedBeforeTheOrchestrator(body({ steps }));
  });

  it("refuses another user's private image under a free-text field name read by `$ref`", async () => {
    givenImage(OTHER_USER, false);
    const steps = body().steps;
    steps[1] = { ...steps[1], input: { image: { $ref: '$arguments', path: 'prompt' } } };
    await refusedBeforeTheOrchestrator(body({ steps, arguments: { prompt: CDN } }));
  });

  it('refuses arguments nested past the walk bound', async () => {
    let deep: unknown = CDN;
    for (let i = 0; i < 70; i++) deep = { a: deep };
    await expect(estimate(body({ arguments: { deep } }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'step input nests too deeply',
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a token the step arms refuse before reading its input', async () => {
    h.authorize.mockImplementation(async () =>
      claims({ ctx: { slotId: 'model.sidebar_top', entityType: 'model', modelId: 5 } })
    );
    const make = () => ({
      kind: 'step' as const,
      step: 'convert-image',
      params: { image: CDN, note: 'a'.repeat(4.1 * 1024 * 1024), output: { format: 'png' } },
    });
    const refusal = { code: 'FORBIDDEN', message: 'registry steps are page-only' };
    await expect(estimate(make())).rejects.toMatchObject(refusal);
    await expect(submit(make())).rejects.toMatchObject(refusal);
  });

  it('on estimate, a quoteId does not move the token checks after the input', async () => {
    givenImage(OTHER_USER, false);
    h.authorize.mockImplementation(async () =>
      claims({ ctx: { slotId: 'model.sidebar_top', entityType: 'model', modelId: 5 } })
    );
    await expect(
      estimate({ ...passThroughWith(CDN), quoteId: `sq_${'1'.repeat(32)}` })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'registry steps are page-only',
    });
  });

  it('refuses registry params too large to read whole, on estimate AND submit', async () => {
    const make = () => ({
      kind: 'step' as const,
      step: 'convert-image',
      params: { image: CDN, note: 'a'.repeat(4.1 * 1024 * 1024), output: { format: 'png' } },
    });
    const refusal = { code: 'BAD_REQUEST', message: 'step input is too large to check' };
    await expect(estimate(make())).rejects.toMatchObject(refusal);
    await expect(submit(make())).rejects.toMatchObject(refusal);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a captioning step’s media',
      { $type: 'mediaCaptioning', input: { mediaUrl: 'https://example.com/a.png' } },
    ],
    [
      'a transcription step’s media',
      { $type: 'transcription', input: { mediaUrl: 'https://example.com/a.mp3' } },
    ],
    [
      'an image part of a chat message',
      {
        $type: 'chatCompletion',
        input: {
          model: 'm',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
              ],
            },
          ],
        },
      },
    ],
  ])('refuses an external url in %s, which the orchestrator fetches', async (_, step) => {
    await expect(estimate({ kind: 'step' as const, ...step, maxBuzz: 30 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('hosted outside Civitai'),
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('CONTROL: the same external link in a generation step input is refused', async () => {
    await expect(
      estimate({
        kind: 'step' as const,
        $type: 'videoGen',
        input: { engine: 'wan', prompt: 'x', images: ['https://example.com/a.png'] },
        maxBuzz: 30,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('hosted outside Civitai'),
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  const chatWithWholeUrls = () => ({
    model: 'm',
    messages: [
      { role: 'user', content: 'https://example.com/page' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', arguments: 'https://example.com/args' }],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'f',
          parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
        },
      },
    ],
  });

  it('accepts whole external urls in a lone chat step’s message text, tool calls and tool schemas', async () => {
    await estimate({
      kind: 'step' as const,
      $type: 'chatCompletion',
      input: chatWithWholeUrls(),
      maxBuzz: 30,
    }).catch(() => undefined);
    expect(whatifs().length).toBeGreaterThan(0);
  });

  it('CONTROL: the same chat input in a workflow is read whole, and refused', async () => {
    await expect(
      estimate({
        kind: 'workflow' as const,
        steps: [{ name: 'chat', $type: 'chatCompletion', input: chatWithWholeUrls() }],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('hosted outside Civitai'),
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('accepts a chat body whose text, tool schema and tool call ids mention urls and uuids', async () => {
    givenImage(OTHER_USER, false);
    await estimate({
      kind: 'step' as const,
      $type: 'chatCompletion',
      input: {
        messages: [
          {
            role: 'user',
            content: `Summarize https://example.com and https://civitai.com/models/1`,
          },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
                arguments: `{"u":"https://example.com/a.png"}`,
              },
            ],
          },
          { role: 'tool', tool_call_id: 'f3a9c2e1-0b4d-4e6f-9a8b-7c6d5e4f3a2b', content: 'ok' },
        ],
        tools: [{ parameters: { $schema: 'http://json-schema.org/draft-07/schema#' } }],
      },
      maxBuzz: 30,
    }).catch(() => undefined);
    expect(whatifs().length).toBeGreaterThan(0);
  });

  it.each([
    [OTHER_USER, 'refuses'],
    [VIEWER, 'accepts'],
  ] as const)(
    'a chat message carrying an image CDN url among words: owner %s -> %s',
    async (owner, verdict) => {
      givenImage(owner, false);
      const chat = {
        kind: 'step' as const,
        $type: 'chatCompletion',
        input: { messages: [{ role: 'user', content: `what is in this picture?\n${CDN}` }] },
        maxBuzz: 30,
      };
      if (verdict === 'refuses') await refusedBeforeTheOrchestrator(chat);
      else {
        await estimate(chat).catch(() => undefined);
        expect(whatifs().length).toBeGreaterThan(0);
      }
    }
  );

  describe('a chat App Block (the registry chat-completion step)', () => {
    const chatStep = (content: string) => ({
      kind: 'step' as const,
      step: 'chat-completion',
      params: {
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content }],
        maxTokens: 128,
      },
    });

    it('POSITIVE CONTROL: a plain message reaches the orchestrator', async () => {
      await estimate(chatStep('hello')).catch(() => undefined);
      expect(whatifs().length).toBeGreaterThan(0);
    });

    // A whole url with a control byte inside is refused as an image input anywhere else (see
    // 'refuses a url with a control byte inside'). In message text it is words.
    it('reads message text as text: a link in it is not refused as an image input', async () => {
      await estimate(chatStep('https://example.com/a\u0001.png')).catch(() => undefined);
      expect(whatifs().length).toBeGreaterThan(0);
    });

    it("still refuses another user's private image named in message text", async () => {
      givenImage(OTHER_USER, false);
      await refusedBeforeTheOrchestrator(chatStep(CDN));
      await refusedBeforeTheOrchestrator(chatStep(`what is in this picture?\n${CDN}`));
    });

    describe('with the external-host refusal ON', () => {
      beforeEach(() => {
        flags.refuseExternal = true;
      });
      afterEach(() => {
        flags.refuseExternal = false;
      });

      // 🔴 THE PRODUCTION REPRO: a chat block that declares a registry tool, with `parameters` as
      // `z.toJSONSchema` emits it (the `$schema` dialect url included), saying "hello".
      const zodParameters = () =>
        z.toJSONSchema(getBlockTool('search_models')!.argsSchema, {
          io: 'input',
          unrepresentable: 'any',
        });
      const senseiBody = () => ({
        kind: 'step' as const,
        step: 'chat-completion',
        params: {
          model: 'deepseek/deepseek-chat',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 128,
          tools: [
            {
              type: 'function',
              function: {
                name: 'search_models',
                description: getBlockTool('search_models')!.description,
                parameters: zodParameters(),
              },
            },
          ],
        },
      });

      it('accepts a plain message whose declared tool schema carries $schema', async () => {
        expect(zodParameters().$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        const error = await estimate(senseiBody()).then(
          () => undefined,
          (e: unknown) => e
        );
        expect(error).not.toMatchObject({ message: GENERATION_EXTERNAL_IMAGE_MESSAGE });
        expect(whatifs().length).toBeGreaterThan(0);
      });

      it('POSITIVE CONTROL: the refusal is live — the same schema in a workflow, read whole, is refused', async () => {
        const refusal = { code: 'BAD_REQUEST', message: GENERATION_EXTERNAL_IMAGE_MESSAGE };
        const passThrough = {
          kind: 'workflow' as const,
          steps: [{ name: 'chat', $type: 'chatCompletion', input: senseiBody().params }],
        };
        await expect(estimate(passThrough)).rejects.toMatchObject(refusal);
        await expect(submit(passThrough)).rejects.toMatchObject(refusal);
        expect(h.submitWorkflow).not.toHaveBeenCalled();
      });
    });

    it('a workflow still reads a link in a $ref-wired text field as an image input', async () => {
      const [gen, , transcode] = body().steps;
      const upscale = {
        $type: 'imageUpscaler',
        input: { image: { $ref: '$arguments', path: 'prompt' } },
      };
      const steps = [gen, upscale, transcode];
      await refusedBeforeTheOrchestrator(
        body({ steps, arguments: { prompt: 'https://example.com/a\u0001.png' } })
      );
    });
  });

  it('the registry step refuses an external host', async () => {
    const error = await estimate(registryWith('https://example.com/a.png')).catch((e) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(error.message)).toContain('hosted outside Civitai');
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a signed-out viewer before reading any image', async () => {
    h.authorize.mockImplementation(async () => claims({ sub: ANON_SUBJECT }));
    givenImage(OTHER_USER, false);
    await expect(estimate(passThroughWith(CDN))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('inline customComfy — the generation input gate', () => {
  const OTHER_USER = 7;
  const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
  const CDN = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/original=true`;
  const OWN_KEY = '11111111-2222-4333-8444-555555555555';

  function givenImage(owner: number, row: { scanComplete?: boolean; held?: boolean } = {}) {
    const scanComplete = row.scanComplete ?? true;
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('').includes('FROM "Image" i')
        ? [
            {
              url: KEY,
              userId: owner,
              visible: false,
              blocked: false,
              scanComplete,
              scanPending: !scanComplete,
              held: row.held ?? false,
            },
          ]
        : []) as never);
  }
  afterEach(() => dbMock.dbWrite.$queryRaw.mockReset());
  // The customComfy arm reads the session user, and the issue record from the in-memory store.
  beforeEach(() => {
    const viewer = { id: VIEWER, isModerator: false, email: 'v@example.com', username: 'v' };
    dbMock.dbRead.user.findUnique.mockImplementation((async () => viewer) as never);
    redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
      keys.map((k) => store.get(k) ?? null)) as never);
  });
  afterEach(() => {
    dbMock.dbRead.user.findUnique.mockReset();
    redisMock.sysRedis.mGet.mockReset();
  });

  const inline = (inputs: Record<string, unknown> = {}) => ({
    kind: 'customComfy' as const,
    mode: 'inline' as const,
    workflow: {
      '1': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a serene lake', clip: ['1', 1] } },
      '3': { class_type: 'LoadImage', inputs },
    },
    resources: [],
    maxBuzz: 60,
  });

  it("refuses another user's private image on estimate AND submit, before any orchestrator call", async () => {
    givenImage(OTHER_USER);
    const refusal = { code: 'BAD_REQUEST', message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE };
    await expect(estimate(inline({ image: CDN }))).rejects.toMatchObject(refusal);
    await expect(submit(inline({ image: CDN }))).rejects.toMatchObject(refusal);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter(USER_CAP)).toBe(0);
  });

  it('refuses an own held image on estimate AND submit', async () => {
    givenImage(VIEWER, { held: true });
    const refusal = { code: 'BAD_REQUEST', message: APP_SOURCE_UNUSABLE_MESSAGE };
    await expect(estimate(inline({ image: CDN }))).rejects.toMatchObject(refusal);
    await expect(submit(inline({ image: CDN }))).rejects.toMatchObject(refusal);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('an own upload still being scanned is a failed snapshot with a code to retry on', async () => {
    givenImage(VIEWER, { scanComplete: false });
    for (const call of [estimate, submit]) {
      await expect(call(inline({ image: CDN }))).resolves.toMatchObject({
        snapshot: { status: 'failed', errorCode: 'source-scan-pending' },
      });
    }
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter(USER_CAP)).toBe(0);
  });

  it('submit gates its own graph: an image swapped in after a passing estimate is refused', async () => {
    givenImage(OTHER_USER);
    const body = inline();
    await expect(estimate(body)).resolves.toMatchObject({ snapshot: { status: 'pending' } });
    (body.workflow['3'].inputs as Record<string, unknown>).image = CDN;
    await expect(submit(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('reads the whole graph: an image url in a text field is checked too', async () => {
    givenImage(OTHER_USER);
    const body = inline();
    body.workflow['2'].inputs.text = `restyle ${CDN}`;
    await expect(submit(body)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ['unrowed', async () => recordUploadKeyOwner(OWN_KEY, VIEWER)],
    [
      'store-unreadable',
      async () => {
        await recordUploadKeyOwner(OWN_KEY, VIEWER);
        redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
      },
    ],
  ])('refuses an own row-less upload (%s) before any orchestrator call', async (reason, given) => {
    dbMock.dbWrite.$queryRaw.mockImplementation((async () => []) as never);
    await given();
    loggingMock.logToAxiom.mockClear();
    const body = inline();
    (body.workflow['2'].inputs as Record<string, unknown>).text = `restyle ${OWN_KEY}`;
    await expect(submit(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APP_SOURCE_UNUSABLE_MESSAGE,
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-block-source-refusal', reason })
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('counts an orchestrator blob on the estimate and on the submit', async () => {
    const blob = 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg';
    const body = inline({ image: blob });
    loggingMock.logToAxiom.mockClear();
    await estimate(body).catch(() => undefined);
    await submit(body).catch(() => undefined);
    const phases = loggingMock.logToAxiom.mock.calls
      .map(([data]) => data as Record<string, unknown>)
      .filter((data) => data.reason === 'host-orchestrator-source')
      .map((data) => data.phase);
    expect(phases).toEqual(['estimate', 'submit']);
  });

  it('refuses inline image bytes in a node input at the schema', async () => {
    const png = `data:image/png;base64,${'iVBORw0KGgo'.repeat(40)}`;
    await expect(submit(inline({ image: png }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [
      'nests too deeply',
      () => {
        let deep: unknown = 'x';
        for (let i = 0; i < 80; i++) deep = { v: deep };
        return deep;
      },
    ],
    ['is too large to check', () => 'a\n'.repeat(70_000)],
  ])('refuses a graph that %s, never passing it unscanned', async (what, text) => {
    for (const call of [estimate, submit]) {
      const body = inline();
      (body.workflow['2'].inputs as Record<string, unknown>).text = text();
      await expect(call(body)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `workflow graph ${what}`,
      });
    }
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('inline customComfy — nodes the host does not run inline', () => {
  beforeEach(() => {
    const viewer = { id: VIEWER, isModerator: false, email: 'v@example.com', username: 'v' };
    dbMock.dbRead.user.findUnique.mockImplementation((async () => viewer) as never);
  });
  afterEach(() => dbMock.dbRead.user.findUnique.mockReset());

  const AIR = 'urn:air:sdxl:lora:civitai:101@202';
  type Node = { class_type: string; inputs: Record<string, unknown> };
  const graphWith = (node: Node) => ({
    kind: 'customComfy' as const,
    mode: 'inline' as const,
    workflow: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: AIR } },
      '2': { class_type: 'StringConcatenate', inputs: { string_a: 'a', string_b: 'b' } },
      '3': node,
    },
    resources: [AIR],
    maxBuzz: 60,
  });
  const refused = { snapshot: { status: 'failed', errorCode: 'inline-node-refused' } };

  it.each([
    ['a path node', { class_type: 'VHS_LoadImagePath', inputs: { image: '/x.png' } }],
    ['a linked loader input', { class_type: 'LoadImage', inputs: { image: ['2', 0] } }],
    ['a local file in a loader', { class_type: 'LoadImage', inputs: { image: 'x.png' } }],
  ])('refuses %s on estimate AND submit, before any orchestrator call', async (_what, node) => {
    for (const call of [estimate, submit]) {
      await expect(call(graphWith(node))).resolves.toMatchObject(refused);
    }
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(counter(USER_CAP)).toBe(0);
  });

  it('estimates a LoRA loader with linked model, CLIP and strength', async () => {
    const node = {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['1', 1], lora_name: AIR, strength_model: ['2', 0] },
    };
    await expect(estimate(graphWith(node))).resolves.toMatchObject({
      snapshot: { status: 'pending' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `accountType` is PER WORKFLOW: the orchestrator takes one `currencies` list for
// the whole workflow, so the pick sits on the body, not on a step. Asserted as the
// literal `currencies` on the whatif AND the real submit. Each pick expects an
// order the no-pick default cannot produce, so a path that drops it fails.
describe("kind:'workflow' — accountType (the pool tried first)", () => {
  const MATURE = { maxBrowsingLevel: 31 };
  const SFW = { maxBrowsingLevel: 1 };
  const currenciesOf = (args: SubmitArgs[]) =>
    args.map((a) => (a.body as { currencies?: unknown }).currencies);
  const withPick = (pick: string | undefined) =>
    pick === undefined ? body() : body({ accountType: pick });
  const PICKS = [
    { name: 'a mature app, yellow pick', rating: MATURE, pick: 'yellow', want: ['yellow', 'blue'] },
    { name: 'an SFW app, green pick', rating: SFW, pick: 'green', want: ['green', 'blue'] },
    { name: 'an SFW app, no pick', rating: SFW, pick: undefined, want: ['blue', 'green'] },
    { name: 'a mature app, no pick', rating: MATURE, pick: undefined, want: ['blue', 'yellow'] },
  ] as const;

  it.each(PICKS)('ESTIMATE — $name quotes with $want', async ({ rating, pick, want }) => {
    h.authorize.mockImplementation(async () => claims(rating));
    const { snapshot } = await estimate(withPick(pick));
    expect(snapshot.status).toBe('pending');
    expect(currenciesOf(whatifs())).toEqual([want]);
  });

  it.each(PICKS)(
    'SUBMIT — $name sends $want on the quote AND the real submit',
    async ({ rating, pick, want }) => {
      h.authorize.mockImplementation(async () => claims(rating));
      const { snapshot } = await submit(withPick(pick));
      expect(snapshot.workflowId).toBe(WORKFLOW_ID);
      expect(currenciesOf(whatifs())).toEqual([want]);
      expect(currenciesOf(realSubmits())).toEqual([want]);
    }
  );

  it.each([
    ['estimate', estimate],
    ['submit', submit],
  ] as const)(
    '%s — a yellow pick on an SFW app is BAD_REQUEST, nothing quoted or reserved',
    async (_name, call) => {
      h.authorize.mockImplementation(async () => claims(SFW));
      await expect(call(withPick('yellow'))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: "buzz account 'yellow' is not spendable for this app's content rating",
      });
      expect(h.submitWorkflow).not.toHaveBeenCalled();
      expect(counter(USER_CAP)).toBe(0);
    }
  );
});
