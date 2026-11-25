import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as AuthorFeeChargeModule from '~/server/services/blocks/author-fee-charge.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as OrchestrationNewModule from '~/server/services/orchestrator/orchestration-new.service';

/**
 * The OUTPUT UNLOCK through `blocksRouter.unlockOutput` with the REAL reservation helpers and the
 * REAL app spend cap over an in-memory Redis (so a reservation, if one were taken, would MOVE a
 * counter), the REAL per-workflow lock and the REAL author-fee module behind spies. Only the
 * orchestrator, identity and site-guard edges are stubbed.
 *
 * What only this seam can show:
 *   - 🔴 NET ZERO (operator decision): an unlock adds nothing to the viewer's per-app daily limit,
 *     the platform cap or the app's aggregate cap, and is not refused at or over the limit;
 *   - 🔴 NO SECOND AUTHOR FEE (operator decision) on a fee-accrued workflow;
 *   - the orchestrator's insufficient-Yellow refusal comes back as `refused`, with its message;
 *   - not-released tells the viewer why; the lock is released either way.
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
  lift: vi.fn(),
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
  // Both spellings of the orchestrator write route to one spy, so the test reads the same
  // against an implementation that calls either.
  updateWorkflow: (...a: unknown[]) => h.updateWorkflow(...a),
  liftWorkflowMatureRestriction: (...a: unknown[]) => h.lift(...a),
  submitWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  deleteWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNewModule>()),
  assertUnlockReleasesOutput: (...a: unknown[]) => h.assertUnlockReleasesOutput(...(a as [])),
}));
// No session resolves, and the serve flag is off: the unlock behaves as it does today.
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
import { buzzCapRedisKey, consentBudgetRedisKey } from '~/server/services/blocks/block-buzz-cap';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

/** Spelled out, not imported: a missing constant must not make the assertion vacuous. */
const NOT_RELEASED_MESSAGE =
  'The unlock went through, but this output is rated above your browsing level, so it stays hidden.';
const INSUFFICIENT_FUNDS_MESSAGE = 'You do not have enough yellow Buzz to unlock this output.';

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
  // `delIfValue`'s compare-and-delete, the only script on this path.
  r.eval.mockImplementation(
    async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
      const [k] = opts.keys;
      if (store.get(k) !== opts.arguments[0]) return 0;
      store.delete(k);
      return 1;
    }
  );
}
const keysWith = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix));
const LOCK_PREFIX = 'system:blocks:output-unlock-lock';

// ── Fixtures ────────────────────────────────────────────────────────────────
const VIEWER = 42;
const APP = 'app_test';
const WF = `${VIEWER}-20261115120000000`;
/** The orchestrator's yellow price: 157 Blue debited, 20 credited back. */
const UNLOCK_PRICE = 137;
const ALL = 1 | 2 | 4 | 8 | 16;

/**
 * The three counters an unlock must NOT move, seeded at distinct non-zero values: the viewer's
 * own daily limit for this app (the consent counter), the platform per-user cap, and the app's
 * aggregate daily cap (the key `app-spend-cap.service` builds).
 */
const consentKey = () => consentBudgetRedisKey(VIEWER, 'apb_test');
const platformKey = () => buzzCapRedisKey(VIEWER);
const appCapKey = () =>
  `${REDIS_SYS_KEYS.BLOCKS.APP_SPEND_CAP}:apb_test:${new Date().toISOString().slice(0, 10)}`;
function seedCounters(consent: number) {
  store.set(consentKey(), String(consent));
  store.set(platformKey(), '250');
  store.set(appCapKey(), '900');
}

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
  h.lift.mockImplementation(async () => {
    unlocked = true;
    return { outcome: 'lifted' };
  });
  seedCounters(400);
  // The viewer's own daily limit for this app: 1000, so a reservation would have room to land.
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

const orchestratorWrites = () => h.lift.mock.calls.length + h.updateWorkflow.mock.calls.length;

/** The unlock-charged-not-released counter for one read-back outcome, from the default registry. */
async function chargedNotReleased(readBack: 'ok' | 'failed'): Promise<number> {
  const metric = client.register.getSingleMetric(
    'civitai_app_block_unlock_charged_not_released_total'
  );
  const values = metric ? (await metric.get()).values : [];
  return values.find((v) => v.labels.read_back === readBack)?.value ?? 0;
}

describe('blocks.unlockOutput — the seam', () => {
  it('🔴 an unlock of a fee-accrued workflow charges no author fee and writes no accrual row', async () => {
    const before = await chargedNotReleased('ok');
    const result = await unlock();
    // CONTROL for the not-released counter: a released output counts nothing.
    expect(await chargedNotReleased('ok')).toBe(before);
    expect(result.outcome).toBe('unlocked');
    expect(result.snapshot.outputs?.[1]).toEqual({ url: 'https://cdn/r1.png', nsfwLevel: 'r' });
    expect(result.charged).toEqual({ unlockBuzz: UNLOCK_PRICE });
    // The orchestrator's yellow swap is the only charge.
    expect(orchestratorWrites()).toBe(1);
    expectNoAuthorFee();
  });

  it('🔴 NET ZERO: a successful unlock leaves the daily limit, the platform cap and the app cap unchanged', async () => {
    expect(store.get(consentKey())).toBe('400');
    const result = await unlock();
    expect(result.outcome).toBe('unlocked');
    expect(store.get(consentKey())).toBe('400');
    expect(store.get(platformKey())).toBe('250');
    expect(store.get(appCapKey())).toBe('900');
    // Nothing else was written either, and the lock is gone.
    expect([...store.keys()].sort()).toEqual([appCapKey(), consentKey(), platformKey()].sort());
  });

  it('🔴 an unlock is not refused when the viewer is at, or over, their daily limit for the app', async () => {
    for (const spent of [1000, 1500]) {
      store.clear();
      seedCounters(spent);
      unlocked = false;
      const result = await unlock();
      expect(result.outcome, `spent ${spent} of 1000`).toBe('unlocked');
      expect(store.get(consentKey())).toBe(String(spent));
    }
  });

  it("the orchestrator's insufficient-Yellow refusal is 'refused', with its message, and counts nothing", async () => {
    h.lift.mockImplementation(async () => ({ outcome: 'insufficient-funds' }));
    const result = await unlock();
    expect(result.outcome).toBe('refused');
    expect(result.message).toBe(INSUFFICIENT_FUNDS_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('r1.png');
    expect(store.get(consentKey())).toBe('400');
    expect(keysWith(LOCK_PREFIX)).toEqual([]);
    expectNoAuthorFee();
  });

  it('any other orchestrator failure throws, counts nothing and releases the lock', async () => {
    h.lift.mockImplementation(async () => {
      throw new Error('orchestrator unavailable');
    });
    await expect(unlock()).rejects.toThrow('orchestrator unavailable');
    expect(store.get(consentKey())).toBe('400');
    expect(keysWith(LOCK_PREFIX)).toEqual([]);
    expectNoAuthorFee();
  });

  it('🔴 not-released: the swap stands, the viewer is told why, no cap or fee is counted', async () => {
    // The orchestrator accepts the unlock, but its read-back still withholds the output.
    h.lift.mockImplementation(async () => ({ outcome: 'lifted' }));
    const before = await chargedNotReleased('ok');
    const result = await unlock();
    expect(await chargedNotReleased('ok')).toBe(before + 1);
    expect(result.outcome).toBe('not-released');
    expect(result.message).toBe(NOT_RELEASED_MESSAGE);
    expect(JSON.stringify(result)).not.toContain('r1.png');
    expect(store.get(consentKey())).toBe('400');
    expect(store.get(appCapKey())).toBe('900');
    expectNoAuthorFee();
  });

  it('🔴 a read-back that fails after the lift counts as failed, not ok', async () => {
    h.lift.mockImplementation(async () => ({ outcome: 'lifted' }));
    h.getWorkflow
      .mockImplementationOnce(async () => workflow())
      .mockImplementationOnce(async () => workflow())
      .mockRejectedValueOnce(new Error('read-back unavailable'));
    const [ok, failed] = [await chargedNotReleased('ok'), await chargedNotReleased('failed')];
    const result = await unlock();
    expect(result.outcome).toBe('not-released');
    expect(await chargedNotReleased('failed')).toBe(failed + 1);
    expect(await chargedNotReleased('ok')).toBe(ok);
  });

  it('a retry after the unlock calls the orchestrator no more', async () => {
    await unlock();
    const result = await unlock();
    expect(result.outcome).toBe('not-restricted');
    expect(orchestratorWrites()).toBe(1);
    expectNoAuthorFee();
  });

  it('🔴 a write that times out keeps the lock: the outcome says check back, a retry is refused as in progress', async () => {
    h.lift.mockImplementation(async () => ({ outcome: 'no-response' }));
    const result = await unlock();
    expect(result.outcome).toBe('unavailable');
    expect(result.message).toBe(
      'Your unlock may still be going through. Check again in a few minutes.'
    );
    expect(keysWith(LOCK_PREFIX)).toHaveLength(1);
    // The orchestrator write may still land; a second unlock must not race it.
    await expect(unlock()).rejects.toThrow('This output is already being unlocked.');
    expect(orchestratorWrites()).toBe(1);
    expect(store.get(consentKey())).toBe('400');
  });

  // Decision (civitai/civitai#10435): a comic panel's workflow unlocks only from the comic editor, which holds the panel's
  // claim (the refusal itself is pinned in updateWorkflow.unlock-cap.test.ts). Keep the flag here.
  it("🔴 the unlock check runs as outside the comic editor, so a comic panel's workflow is refused", async () => {
    await unlock();
    expect(h.assertUnlockReleasesOutput).toHaveBeenCalledWith({
      token: 'orch-token',
      workflowId: WF,
      outsideComicEditor: true,
    });
  });
});

async function outcomeUnknown(): Promise<number> {
  const metric = client.register.getSingleMetric('civitai_app_block_unlock_outcome_unknown_total');
  const values = metric ? (await metric.get()).values : [];
  return values[0]?.value ?? 0;
}

describe('blocks.unlockOutput — an unlock whose outcome is unknown', () => {
  it('🔴 a write with no answer is counted once for support', async () => {
    h.lift.mockImplementation(async () => ({ outcome: 'no-response' }));
    const before = await outcomeUnknown();
    const result = await unlock();
    expect(result.outcome).toBe('unavailable');
    expect(await outcomeUnknown()).toBe(before + 1);
  });

  it('CONTROL: a confirmed unlock counts nothing', async () => {
    const before = await outcomeUnknown();
    const result = await unlock();
    expect(result.outcome).toBe('unlocked');
    expect(await outcomeUnknown()).toBe(before);
  });
});
