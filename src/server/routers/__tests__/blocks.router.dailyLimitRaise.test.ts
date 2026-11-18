import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiKeySpend from '~/server/http/orchestrator/api-key-spend';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ScopeGrant from '~/server/services/blocks/scope-grant.service';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';

/**
 * `blocks.getMyAppDailyLimit` / `blocks.raiseAppDailyLimit`: the session procedures behind the
 * host's raise dialog. Pins every gate that keeps them shut (flag, approval, rate limit, a stale
 * dialog) and that a raise is recorded with the limit it replaced.
 */

const { mockIsAppBlocksEnabled, m } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  m: {
    raiseFlag: vi.fn(async () => true),
    withinLimitFlag: vi.fn(async () => false),
    optedIn: vi.fn(async (): Promise<number | null> => null),
    optIn: vi.fn(),
    optOut: vi.fn(async () => undefined),
    readLimit: vi.fn(),
    raise: vi.fn(),
    record: vi.fn(async () => undefined),
  },
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: vi.fn(),
    listAvailable: vi.fn(),
    upsertSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    upsertUserSettings: vi.fn(),
    getEffectiveCheckpoint: vi.fn(),
  },
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppDailyLimitRaiseEnabled: m.raiseFlag,
  isAppConfirmedStepWithinLimitEnabled: m.withinLimitFlag,
}));
vi.mock('~/server/services/blocks/scope-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeGrant>()),
  readConsentDailyLimit: m.readLimit,
  raiseConsentDailyLimit: m.raise,
  recordConsentLimitChange: m.record,
  readConfirmWithinLimit: m.optedIn,
  optInConfirmWithinLimit: m.optIn,
  optOutConfirmWithinLimit: m.optOut,
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockScopeMiddleware>()),
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
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
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
// The mirror teardown's two orchestrator calls.
vi.mock('~/server/http/orchestrator/api-key-spend', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeySpend>()),
  deleteAuthSubject: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
// Same import-chain shim every sibling blocks.router suite uses: `rateLimit` transitively
// evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const appBlockFindUnique = dbMock.dbRead.appBlock.findUnique;
const USER = 42;
const APP = 'apb_x';

function caller(apiKeyId: number | null = null) {
  return blocksRouter.createCaller({
    acceptableOrigin: true,
    user: { id: USER, isModerator: false, onboarding: 0x1f } as never,
    apiKeyId,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {
      canViewNsfw: false,
      isBlue: false,
      isGreen: false,
      isGreenSession: false,
      appBlocks: true,
    } as never,
    track: undefined,
  } as never);
}

/** Every `SET` the read limiter's MULTI sent: `[key, value, options]`. */
let readRateSets: unknown[][] = [];

beforeEach(() => {
  vi.clearAllMocks();
  m.raiseFlag.mockResolvedValue(true);
  appBlockFindUnique.mockResolvedValue({ status: 'approved' } as never);
  redisMock.redis.incrBy.mockResolvedValue(1 as never);
  // The read limiter counts with SET NX EX + INCR in one MULTI; its INCR answers from the
  // `redis.incrBy` mock, so a test sets the count there.
  readRateSets = [];
  redisMock.redis.multi.mockImplementation((() => {
    const queued: Array<() => unknown> = [];
    const chain = {
      set: (...a: unknown[]) => {
        readRateSets.push(a);
        queued.push(() => 'OK');
        return chain;
      },
      incr: (key: string) => {
        queued.push(() => redisMock.redis.incrBy(key, 1));
        return chain;
      },
      exec: async () => Promise.all(queued.map((op) => op())),
    };
    return chain;
  }) as never);
  redisMock.redis.get.mockResolvedValue(null as never);
  m.readLimit.mockResolvedValue({ limit: 1000, spentToday: 980, remaining: 20, exceeds: false });
  m.raise.mockResolvedValue({ previousLimit: 1000 });
  m.withinLimitFlag.mockResolvedValue(false);
  m.optedIn.mockResolvedValue(null);
});

describe('blocks.getMyAppDailyLimit', () => {
  it("returns the viewer's own limit, today's spend and whether a refusal is on record", async () => {
    redisMock.redis.get.mockImplementation((async (key: string) =>
      key === `system:blocks:consent-limit-refused:${USER}:${APP}` ? '1000' : null) as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toEqual({
      limit: 1000,
      spentToday: 980,
      refusedRecently: true,
      confirmWithinLimitMaxJob: null,
    });
    expect(m.readLimit).toHaveBeenCalledWith(USER, APP, 0);
  });

  it('a refusal at an earlier limit no longer counts once the limit changed', async () => {
    redisMock.redis.get.mockImplementation((async (key: string) =>
      key === `system:blocks:consent-limit-refused:${USER}:${APP}` ? '500' : null) as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toMatchObject({
      limit: 1000,
      refusedRecently: false,
    });
  });

  it('control: with no refusal on record it says so', async () => {
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toMatchObject({
      refusedRecently: false,
    });
  });

  it('flag off: null, and nothing is read', async () => {
    m.raiseFlag.mockResolvedValue(false);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toBeNull();
    expect(m.readLimit).not.toHaveBeenCalled();
  });

  it('an unapproved app: null', async () => {
    appBlockFindUnique.mockResolvedValue({ status: 'suspended' } as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toBeNull();
    expect(m.readLimit).not.toHaveBeenCalled();
  });

  it('no limit to raise: null', async () => {
    m.readLimit.mockResolvedValue(null);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toBeNull();
  });

  it('over 30 reads a minute: null, and nothing is read', async () => {
    redisMock.redis.incrBy.mockResolvedValue(31 as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toBeNull();
    expect(m.readLimit).not.toHaveBeenCalled();
  });

  it('the 30th read in a minute still reads', async () => {
    redisMock.redis.incrBy.mockResolvedValue(30 as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).not.toBeNull();
    expect(m.readLimit).toHaveBeenCalled();
    // The window is created with its one-minute TTL in the same MULTI as the count.
    expect(readRateSets).toEqual([
      [`system:blocks:daily-limit-read-rate:${USER}`, '0', { NX: true, EX: 60 }],
    ]);
    // The rate window and the refusal record are on the cache cluster, not in system Redis.
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
    expect(
      redisMock.sysRedis.get.mock.calls.filter(([k]: unknown[]) =>
        String(k).startsWith('system:blocks:consent-limit-refused:')
      )
    ).toEqual([]);
  });

  it('a Redis error on the rate limit fails closed', async () => {
    redisMock.redis.incrBy.mockRejectedValue(new Error('down') as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toBeNull();
  });
});

describe('blocks.raiseAppDailyLimit', () => {
  it('raises, and records the limit it replaced', async () => {
    expect(await caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 })).toEqual({
      previousLimit: 1000,
      limit: 2000,
    });
    expect(m.raise).toHaveBeenCalledWith({ userId: USER, appBlockId: APP, buzzBudgetPerDay: 2000 });
    expect(m.record).toHaveBeenCalledWith({
      userId: USER,
      appBlockId: APP,
      previousLimit: 1000,
      limit: 2000,
    });
  });

  it('flag off: FORBIDDEN, nothing written', async () => {
    m.raiseFlag.mockResolvedValue(false);
    await expect(
      caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(m.raise).not.toHaveBeenCalled();
  });

  it('an unapproved app: BAD_REQUEST, nothing written', async () => {
    appBlockFindUnique.mockResolvedValue({ status: 'suspended' } as never);
    await expect(
      caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(m.raise).not.toHaveBeenCalled();
  });

  it('a stale dialog (nothing raised): PRECONDITION_FAILED, nothing recorded', async () => {
    m.raise.mockResolvedValue(null);
    await expect(
      caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(m.record).not.toHaveBeenCalled();
  });

  it('above the platform ceiling for one app: refused before any write', async () => {
    await expect(
      caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 50_001 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(m.raise).not.toHaveBeenCalled();
  });
});

describe('the "run without asking" opt-in', () => {
  it('the raise dialog learns the viewer opted in, so it can say jobs will run without asking', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optedIn.mockResolvedValue(1040);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toMatchObject({
      confirmWithinLimitMaxJob: 1040,
    });
  });

  it('with the flag rolled back the raise dialog still learns of a kept opt-in, which re-arms with the flag', async () => {
    m.optedIn.mockResolvedValue(1040);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toMatchObject({
      confirmWithinLimitMaxJob: 1040,
    });
    expect(m.withinLimitFlag).not.toHaveBeenCalled();
  });

  it('control: not opted in, the raise dialog reads none', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toMatchObject({
      confirmWithinLimitMaxJob: null,
    });
  });

  it('a raise never opts anyone in', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    await caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 });
    expect(m.optIn).not.toHaveBeenCalled();
  });

  it('opting in with a new limit records the limit change', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optIn.mockResolvedValue({ limit: 1500 });
    expect(
      await caller().optInConfirmWithinLimit({
        appBlockId: APP,
        maxJobBuzz: 1040,
        buzzBudgetPerDay: 1500,
      })
    ).toEqual({ limit: 1500 });
    expect(m.optIn).toHaveBeenCalledWith({
      userId: USER,
      appBlockId: APP,
      maxJob: 1040,
      newLimit: 1500,
    });
    expect(m.record).toHaveBeenCalledWith({
      userId: USER,
      appBlockId: APP,
      previousLimit: null,
      limit: 1500,
    });
  });

  it('opting in on an existing limit records no limit change', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optIn.mockResolvedValue({ limit: 1000 });
    await caller().optInConfirmWithinLimit({ appBlockId: APP, maxJobBuzz: 1040 });
    expect(m.record).not.toHaveBeenCalled();
  });

  it('refuses with the flag off, writing nothing', async () => {
    await expect(
      caller().optInConfirmWithinLimit({ appBlockId: APP, maxJobBuzz: 1040 })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(m.optIn).not.toHaveBeenCalled();
  });

  it('refuses a new limit below the job it was set from', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    await expect(
      caller().optInConfirmWithinLimit({
        appBlockId: APP,
        maxJobBuzz: 1040,
        buzzBudgetPerDay: 1000,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(m.optIn).not.toHaveBeenCalled();
  });

  it('says to reopen when the write matched nothing', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optIn.mockResolvedValue(null);
    await expect(
      caller().optInConfirmWithinLimit({ appBlockId: APP, maxJobBuzz: 1040 })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('the activity page reads the viewer’s own ceiling and today’s spend', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optedIn.mockResolvedValue(1040);
    expect(await caller().getMyConfirmWithinLimit({ appBlockId: APP })).toEqual({
      maxJob: 1040,
      limit: 1000,
      spentToday: 980,
    });
    expect(m.optedIn).toHaveBeenCalledWith(USER, APP, 'read');
  });

  it('with the flag rolled back, a kept opt-in is still shown so it can be turned off', async () => {
    m.optedIn.mockResolvedValue(1040);
    expect(await caller().getMyConfirmWithinLimit({ appBlockId: APP })).toEqual({
      maxJob: 1040,
      limit: 1000,
      spentToday: 980,
    });
    expect(m.withinLimitFlag).not.toHaveBeenCalled();
  });

  it('a full-scope API key or OAuth token can neither opt in nor raise the limit', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optIn.mockResolvedValue({ limit: 1000 });
    // The blockApiKeys refusal's own message, so another FORBIDDEN cannot pass for it.
    const refusal = {
      code: 'FORBIDDEN',
      message: 'This action cannot be performed via API key or OAuth token.',
    };
    await expect(
      caller(5).optInConfirmWithinLimit({ appBlockId: APP, maxJobBuzz: 1040 })
    ).rejects.toMatchObject(refusal);
    await expect(
      caller(5).raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 })
    ).rejects.toMatchObject(refusal);
    expect(m.optIn).not.toHaveBeenCalled();
    expect(m.raise).not.toHaveBeenCalled();
  });

  it('control: the same calls from the session reach the write', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    m.optIn.mockResolvedValue({ limit: 1000 });
    await caller().optInConfirmWithinLimit({ appBlockId: APP, maxJobBuzz: 1040 });
    await caller().raiseAppDailyLimit({ appBlockId: APP, buzzBudgetPerDay: 2000 });
    expect(m.optIn).toHaveBeenCalled();
    expect(m.raise).toHaveBeenCalled();
  });

  it('control: not opted in, nothing to show', async () => {
    m.withinLimitFlag.mockResolvedValue(true);
    expect(await caller().getMyConfirmWithinLimit({ appBlockId: APP })).toBeNull();
  });

  it('switching off clears the signed-in viewer’s own opt-in, even with the flag off', async () => {
    await caller().optOutConfirmWithinLimit({ appBlockId: APP });
    expect(m.optOut).toHaveBeenCalledWith(USER, APP);
  });

  it('switching off works with Apps itself turned off for the viewer', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    try {
      await caller().optOutConfirmWithinLimit({ appBlockId: APP });
    } finally {
      mockIsAppBlocksEnabled.mockResolvedValue(true);
    }
    expect(m.optOut).toHaveBeenCalledWith(USER, APP);
  });
});

/**
 * The ledger of `blocksRouter` procedures that refuse every API key and OAuth token
 * (`blockApiKeys`): the viewer's session only. Read off the built router, so dropping the
 * meta from one, or adding it to another, fails here until the decision is written down.
 */
describe('blockApiKeys ledger', () => {
  it('exactly these blocks procedures are session-only', () => {
    const procedures = blocksRouter._def.procedures as unknown as Record<
      string,
      { _def: { meta?: { blockApiKeys?: boolean } } }
    >;
    const sessionOnly = Object.entries(procedures)
      .filter(([, p]) => p._def.meta?.blockApiKeys === true)
      .map(([name]) => name)
      .sort();
    expect(sessionOnly).toEqual(
      [
        'consentQuoteGrant',
        'consentQuoteGrantStanding',
        'consentTrainingQuote',
        'createPostFromApp',
        'getReactionsForApp',
        // The viewer's standing spend consent and the limit it runs within.
        'optInConfirmWithinLimit',
        'persistAppUploadImage',
        'persistGenerationSource',
        'persistUploadedGenerationSource',
        'presignMediaUploadBatchItem',
        'previewOutputUnlock',
        'previewPostFromApp',
        'previewQuoteGrant',
        'previewTrainingQuote',
        'publishGenerationOutputs',
        'raiseAppDailyLimit',
        'recordMediaUploadBatchItem',
        'setReactionFromApp',
        'startMediaUploadBatch',
        'unlockOutput',
      ].sort()
    );
  });
});
