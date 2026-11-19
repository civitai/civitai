import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * The approve MUTATION refuses while the app has an open review hold. Drives the real
 * `blocksRouter` and the real `approveRequest` + holds service; only the database, Forgejo and
 * env are faked. The refusal lands before any Forgejo write.
 */

const { mockIsAppBlocksEnabled, forgejo } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  forgejo: {
    commitFiles: vi.fn(),
    createRepoFromTemplate: vi.fn(),
    ensurePushWebhook: vi.fn(),
  },
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true, appBlocksPages: false }),
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

vi.mock('~/server/services/blocks/forgejo.service', () => forgejo);

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { appBlocks: true, appBlocksAuthor: true } as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const dev = { id: 2, isModerator: false, tier: 'free', username: 'dev', onboarding: 0x1f };

const openHold = {
  id: 7,
  slug: 'app-a',
  publishRequestId: 'pubreq_1',
  requestKind: 'onsite',
  placedByUserId: 1,
  placedByUsername: 'mod',
  placedByLabel: 'code-check',
  reason: 'security check still running',
  createdAt: new Date(),
  clearedAt: null,
  clearedByUserId: null,
  clearedKind: null,
  clearedReason: null,
};

function holdsTable(rows: unknown[]) {
  dbMock.dbWrite.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    Promise.resolve(
      Prisma.sql(strings, ...values).text.includes('app_publish_request_holds') ? rows : []
    )) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({
    FORGEJO_BASE_URL: 'https://git.example',
    FORGEJO_ADMIN_TOKEN: 't',
    FORGEJO_WEBHOOK_SECRET: 's',
  });
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
    id: 'pubreq_1',
    status: 'pending',
    slug: 'app-a',
    version: '1.0.0',
    manifest: {},
    bundleKey: 'k',
    forgejoCommitSha: null,
    submittedByUserId: 2,
    appBlockId: null,
    deployState: null,
    deployDetail: null,
  } as never);
});

describe('blocks.approveRequest with an open review hold', () => {
  it('refuses with PRECONDITION_FAILED naming the hold, before any Forgejo write', async () => {
    holdsTable([openHold]);
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    const err = await caller.approveRequest({ publishRequestId: 'pubreq_1' }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toContain('code-check (mod): security check still running');
    expect(forgejo.commitFiles).not.toHaveBeenCalled();
    expect(forgejo.createRepoFromTemplate).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 an override naming the shown holds passes the router to the service and gets past the hold check', async () => {
    holdsTable([openHold]);
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    const err = await caller
      .approveRequest({
        publishRequestId: 'pubreq_1',
        holdOverrideReason: 'checked by hand, a false alarm',
        holdOverrideIds: [7],
      })
      .catch((e) => e);
    // It fails later on this fixture's minimal request; what matters is that holds did not stop it.
    expect(err?.code).not.toBe('PRECONDITION_FAILED');
    expect(String(err?.message)).not.toMatch(/review hold/);
    // The hold check did run (and read the hold) before letting it through.
    expect(
      dbMock.dbWrite.$queryRaw.mock.calls.some((c: unknown[]) =>
        Prisma.sql(c[0] as TemplateStringsArray, ...c.slice(1)).text.includes(
          'app_publish_request_holds'
        )
      )
    ).toBe(true);
  });

  it('refuses a too-short override reason at the input', async () => {
    holdsTable([openHold]);
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.approveRequest({ publishRequestId: 'pubreq_1', holdOverrideReason: 'ok.' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(forgejo.commitFiles).not.toHaveBeenCalled();
  });
});

describe('hold procedures are moderator-only', () => {
  it.each([
    [
      'placePublishRequestHold',
      {
        publishRequestId: 'pubreq_1',
        kind: 'onsite',
        reason: 'security check still running',
        label: 'x',
      },
    ],
    ['clearPublishRequestHold', { holdId: 7, reason: 'the check is finished now' }],
    ['listPublishRequestHolds', { slugs: ['app-a'] }],
  ] as const)('%s refuses a non-moderator and never touches the table', async (proc, input) => {
    holdsTable([openHold]);
    const caller = blocksRouter.createCaller(fakeCtx(dev) as never);
    await expect((caller as any)[proc](input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
