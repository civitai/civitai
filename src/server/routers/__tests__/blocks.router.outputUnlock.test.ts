import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as AuthorFeeChargeModule from '~/server/services/blocks/author-fee-charge.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as OrchestrationNewModule from '~/server/services/orchestrator/orchestration-new.service';

/**
 * The OUTPUT UNLOCK through `blocksRouter.unlockOutput` with the REAL reservation helpers over an
 * in-memory Redis, the REAL per-workflow lock and the REAL author-fee module behind spies. Only
 * the orchestrator, identity and site-guard edges are stubbed.
 *
 * What only this seam can show:
 *   - 🔴 NO SECOND AUTHOR FEE (operator decision): unlocking a workflow whose ORIGINAL spend
 *     accrued an author fee charges only the orchestrator's yellow swap. The fee charge, the
 *     quote, the Buzz debit and the accrual write are all unreached.
 *   - the unlock price is counted against the viewer's own per-app daily limit (the consent
 *     counter), and refunded when the orchestrator refuses;
 *   - the lock is released on success and on failure.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertEnabled: vi.fn(async () => undefined),
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  assertUnlockReleasesOutput: vi.fn(async () => undefined),
  chargeAuthorFee: vi.fn(),
  quoteAuthorFee: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
  catalogRate: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BridgeAuthModule>()),
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenAccessModule>()),
  assertAppBlocksEnabledForTokenUser: (...a: unknown[]) => h.assertEnabled(...(a as [])),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: () => h.getOrchestratorToken(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  getWorkflow: (...a: unknown[]) => h.getWorkflow(...a),
  updateWorkflow: (...a: unknown[]) => h.updateWorkflow(...a),
  submitWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  deleteWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNewModule>()),
  assertUnlockReleasesOutput: (...a: unknown[]) => h.assertUnlockReleasesOutput(...(a as [])),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(async () => null),
}));
vi.mock('~/server/services/blocks/author-fee-charge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthorFeeChargeModule>()),
  chargeBlockAuthorFee: (...a: unknown[]) => h.chargeAuthorFee(...(a as [])),
  quoteBlockAuthorFee: (...a: unknown[]) => h.quoteAuthorFee(...(a as [])),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...a: unknown[]) => h.createBuzzTransactionMany(...(a as [])),
  getUserBuzzAccounts: vi.fn(),
  getUserBuzzAccount: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogRate(...(a as [])),
}));
// Same shim the sibling router suites use: cuts the Prisma-generated chain `rateLimit` pulls in.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { appBlockTag } from '~/server/services/blocks/workflow.service';

// ── An in-memory sysRedis: get/set (NX)/del/incrBy/decrBy. ──────────────────
const store = new Map<string, string>();
function installRedis() {
  const r = redisMock.sysRedis;
  r.get.mockImplementation(async (k: string) => store.get(k) ?? null);
  r.set.mockImplementation(async (k: string, v: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && store.has(k)) return null;
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
const keysWith = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix));
const counter = (prefix: string) =>
  keysWith(prefix).reduce((s, k) => s + Number(store.get(k) ?? 0), 0);
const CONSENT_PREFIX = 'system:blocks:consent-budget';
const LOCK_PREFIX = 'system:blocks:output-unlock-lock';

// ── Fixtures ────────────────────────────────────────────────────────────────
const VIEWER = 42;
const APP = 'app_test';
const WF = `${VIEWER}-20261115120000000`;
/** The orchestrator's yellow price: 157 Blue debited, 20 credited back. */
const UNLOCK_PRICE = 137;
const ALL = 1 | 2 | 4 | 8 | 16;

function claims() {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk_test',
    appId: APP,
    appBlockId: 'apb_test',
    blockInstanceId: 'page_apb_test',
    ctx: { slotId: 'app.page', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 1000,
    maxBrowsingLevel: ALL,
    viewerBrowsingLevel: ALL,
  };
}

let unlocked = false;
function workflow() {
  const image = (id: string, nsfwLevel: string) => ({
    id,
    type: 'image',
    url: `https://cdn/${id}.png`,
    available: true,
    width: 512,
    height: 768,
    nsfwLevel,
  });
  return {
    id: WF,
    createdAt: '2026-11-15T12:00:00.000Z',
    status: 'succeeded',
    metadata: {},
    tags: [appBlockTag(APP)],
    allowMatureContent: unlocked,
    cost: { total: 157, base: 150 },
    transactions: {
      list: [
        { type: 'debit', amount: 157, accountType: 'blue' },
        { type: 'credit', amount: 20, accountType: 'blue' },
      ],
    },
    steps: [
      {
        $type: 'textToImage',
        name: 's1',
        status: 'succeeded',
        metadata: {},
        output: { images: [image('pg0', 'pg'), image('r1', 'r')] },
      },
    ],
  };
}

function ctx() {
  return {
    acceptableOrigin: true,
    // guardedProcedure: an onboarded, unmuted session that is the token subject, mature on.
    user: { id: VIEWER, isModerator: false, onboarding: 0xffff, muted: false, showNsfw: true },
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
const unlock = () =>
  caller().unlockOutput({
    blockToken: 't',
    workflowId: WF,
    position: 1,
    expectedTotal: UNLOCK_PRICE,
  });

function expectNoAuthorFee() {
  expect(h.quoteAuthorFee).not.toHaveBeenCalled();
  expect(h.chargeAuthorFee).not.toHaveBeenCalled();
  expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  store.clear();
  for (const fn of Object.values(h)) fn.mockClear();
  installRedis();
  unlocked = false;
  h.authorize.mockImplementation(async () => claims());
  // A WORKING fee path, so an implementation that charged one would get through and be seen
  // doing it, rather than dying on an undefined quote.
  h.quoteAuthorFee.mockImplementation(async () => ({ charge: true, feeBuzz: 8 }));
  h.chargeAuthorFee.mockImplementation(async () => ({
    charged: true,
    feeBuzz: 8,
    accrualId: 'acc_unlock',
  }));
  h.getWorkflow.mockImplementation(async () => workflow());
  h.updateWorkflow.mockImplementation(async (args: { allowMatureContent?: boolean }) => {
    if (args.allowMatureContent === true) unlocked = true;
    return workflow();
  });
  // The viewer's own daily limit for this app, so the consent counter is reserved against.
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
    buzzBudgetPerDay: 1000,
    revokedAt: null,
  } as never);
  // 🔴 The ORIGINAL spend accrued an author fee: the case the operator ruled on.
  dbMock.dbRead.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
    id: 'acc_original',
    workflowId: WF,
    feeBuzz: 8,
    baseGenerationBuzz: 150,
    generationType: 'image:txt2img',
    status: 'accrued',
  } as never);
  dbMock.dbWrite.blockAuthorFeeAccrual.create.mockClear();
});

describe('blocks.unlockOutput — the seam', () => {
  it('🔴 an unlock of a fee-accrued workflow charges no author fee and writes no accrual row', async () => {
    const result = await unlock();
    expect(result.outcome).toBe('unlocked');
    expect(result.snapshot.outputs?.[1]).toEqual({ url: 'https://cdn/r1.png', nsfwLevel: 'r' });
    expect(result.charged).toEqual({ unlockBuzz: UNLOCK_PRICE });
    // The orchestrator's yellow swap is the only charge.
    expect(h.updateWorkflow).toHaveBeenCalledTimes(1);
    expect(h.updateWorkflow.mock.calls[0][0]).toMatchObject({
      workflowId: WF,
      allowMatureContent: true,
      throwOnError: true,
    });
    expectNoAuthorFee();
  });

  it('counts the unlock price against the viewer daily limit for the app, and releases the lock', async () => {
    await unlock();
    // POSITIVE CONTROL for the refund case below: the counter really moves.
    expect(counter(CONSENT_PREFIX)).toBe(UNLOCK_PRICE);
    expect(keysWith(LOCK_PREFIX)).toEqual([]);
  });

  it('an orchestrator refusal refunds the daily limit, charges nothing and releases the lock', async () => {
    h.updateWorkflow.mockImplementation(async () => {
      throw new Error('orchestrator refused the unlock');
    });
    await expect(unlock()).rejects.toThrow('orchestrator refused the unlock');
    expect(counter(CONSENT_PREFIX)).toBe(0);
    expect(keysWith(LOCK_PREFIX)).toEqual([]);
    expectNoAuthorFee();
  });

  it('a retry after the unlock reserves nothing and calls the orchestrator no more', async () => {
    await unlock();
    const result = await unlock();
    expect(result.outcome).toBe('not-restricted');
    expect(h.updateWorkflow).toHaveBeenCalledTimes(1);
    expect(counter(CONSENT_PREFIX)).toBe(UNLOCK_PRICE);
    expectNoAuthorFee();
  });
});
