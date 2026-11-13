import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiKeySpend from '~/server/http/orchestrator/api-key-spend';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ScopeGrant from '~/server/services/blocks/scope-grant.service';

/**
 * `blocks.getMyAppDailyLimit` / `blocks.raiseAppDailyLimit`: the session procedures behind the
 * host's raise dialog. Pins every gate that keeps them shut (flag, approval, rate limit, a stale
 * dialog) and that a raise is recorded with the limit it replaced.
 */

const { mockIsAppBlocksEnabled, m } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  m: {
    raiseFlag: vi.fn(async () => true),
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
}));
vi.mock('~/server/services/blocks/scope-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeGrant>()),
  readConsentDailyLimit: m.readLimit,
  raiseConsentDailyLimit: m.raise,
  recordConsentLimitChange: m.record,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
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

function caller() {
  return blocksRouter.createCaller({
    acceptableOrigin: true,
    user: { id: USER, isModerator: false, onboarding: 0x1f } as never,
    apiKeyId: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  m.raiseFlag.mockResolvedValue(true);
  appBlockFindUnique.mockResolvedValue({ status: 'approved' } as never);
  redisMock.sysRedis.incrBy.mockResolvedValue(1 as never);
  redisMock.sysRedis.get.mockResolvedValue(null as never);
  m.readLimit.mockResolvedValue({ limit: 1000, spentToday: 980, remaining: 20, exceeds: false });
  m.raise.mockResolvedValue({ previousLimit: 1000 });
});

describe('blocks.getMyAppDailyLimit', () => {
  it("returns the viewer's own limit, today's spend and whether a refusal is on record", async () => {
    redisMock.sysRedis.get.mockImplementation((async (key: string) =>
      key === `system:blocks:consent-limit-refused:${USER}:${APP}` ? '1000' : null) as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toEqual({
      limit: 1000,
      spentToday: 980,
      refusedRecently: true,
    });
    expect(m.readLimit).toHaveBeenCalledWith(USER, APP, 0);
  });

  it('a refusal at an earlier limit no longer counts once the limit changed', async () => {
    redisMock.sysRedis.get.mockImplementation((async (key: string) =>
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
    redisMock.sysRedis.incrBy.mockResolvedValue(31 as never);
    expect(await caller().getMyAppDailyLimit({ appBlockId: APP })).toBeNull();
    expect(m.readLimit).not.toHaveBeenCalled();
  });

  it('a Redis error on the rate limit fails closed', async () => {
    redisMock.sysRedis.incrBy.mockRejectedValue(new Error('down') as never);
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
