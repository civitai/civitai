import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP DEV TUNNEL — router authz matrix for startDevTunnel / stopDevTunnel /
 * devTunnelStatus (appDeveloperProcedure + enforceAppBlocksFlag + the
 * `app-blocks-dev-tunnel` kill-switch + ownership):
 *
 *   - non-author (plain non-mod, no cohort) → FORBIDDEN (author capability off).
 *   - author + dev-tunnel flag OFF → FORBIDDEN.
 *   - author + flag ON + NON-owner of blockId → NOT_FOUND (no oracle).
 *   - author + flag ON + owner → mints (service called with the caller's userId).
 */

const {
  mockIsAppBlocksEnabled,
  mockIsDevTunnelEnabled,
  mockResolveDev,
  mockStart,
  mockStop,
  mockStopForUserBlock,
  mockGetActive,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockIsDevTunnelEnabled: vi.fn(async () => true),
  mockResolveDev: vi.fn(),
  mockStart: vi.fn(),
  mockStop: vi.fn(async () => true),
  mockStopForUserBlock: vi.fn(async () => true),
  mockGetActive: vi.fn(async () => null),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveDevPageBlockForAuthor: mockResolveDev,
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksDevTunnelEnabled: mockIsDevTunnelEnabled,
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  startDevTunnel: mockStart,
  stopDevTunnel: mockStop,
  stopDevTunnelForUserBlock: mockStopForUserBlock,
  getActiveDevTunnel: mockGetActive,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: vi.fn() } },
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  return { ...actual, redis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) } };
});
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
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function authedCtx(userId: number, isModerator = true) {
  return {
    acceptableOrigin: true,
    user: { id: userId, isModerator, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const OWN_APP = {
  appBlockId: 'apb_dev',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  status: 'pending',
  trustTier: 'unverified',
  name: 'My App',
  pageTitle: 'My App',
  sandbox: '',
  scopes: [],
  contentRating: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockIsDevTunnelEnabled.mockResolvedValue(true);
  mockResolveDev.mockResolvedValue(OWN_APP);
  mockStart.mockResolvedValue({
    sessionId: 'bki_s',
    host: 'dev-0123456789abcdef.civit.ai',
    url: 'https://civitai.com/apps/dev/my-app',
    expiresAt: 9e9,
    spendCapBuzz: 5000,
  });
});

const PUBKEY = 'ssh-ed25519 AAAAExampleKey dev@laptop';
const input = { blockId: 'my-app', sshPublicKey: PUBKEY };

describe('startDevTunnel — authz matrix', () => {
  it('non-author (plain non-mod, capability off) → FORBIDDEN, never mints', async () => {
    const caller = blocksRouter.createCaller(authedCtx(42, false) as never);
    await expect(caller.startDevTunnel(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('author + dev-tunnel flag OFF → FORBIDDEN, never mints', async () => {
    mockIsDevTunnelEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    await expect(caller.startDevTunnel(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('author + flag ON + NON-owner of blockId → NOT_FOUND (no oracle), never mints', async () => {
    mockResolveDev.mockResolvedValue(null); // foreign/absent app
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    await expect(caller.startDevTunnel(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('author + flag ON + OWNER → mints, bound to the CALLER’s userId', async () => {
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    const res = await caller.startDevTunnel(input);
    expect(res.host).toMatch(/^dev-[a-f0-9]{16}\.civit\.ai$/);
    expect(mockStart).toHaveBeenCalledWith({
      userId: 100,
      blockId: 'my-app',
      sshPublicKey: PUBKEY,
    });
    // ownership resolve was scoped to the caller
    expect(mockResolveDev).toHaveBeenCalledWith('my-app', 100, { db: 'write' });
  });
});

describe('stopDevTunnel / devTunnelStatus', () => {
  it('stopDevTunnel by sessionId → ownership-checked service call', async () => {
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    const res = await caller.stopDevTunnel({ sessionId: 'bki_s' });
    expect(res).toEqual({ ok: true, stopped: true });
    expect(mockStop).toHaveBeenCalledWith(100, 'bki_s');
  });

  it('stopDevTunnel flag OFF → FORBIDDEN', async () => {
    mockIsDevTunnelEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    await expect(caller.stopDevTunnel({ blockId: 'my-app' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('devTunnelStatus returns active:false when no tunnel', async () => {
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    expect(await caller.devTunnelStatus({ blockId: 'my-app' })).toEqual({ active: false });
  });

  it('devTunnelStatus returns the live session for the owner', async () => {
    mockGetActive.mockResolvedValue({
      sessionId: 'bki_s',
      userId: 100,
      blockId: 'my-app',
      host: 'dev-0123456789abcdef.civit.ai',
      hardExpiresAt: 9e9,
      spendCapBuzz: 5000,
    });
    const caller = blocksRouter.createCaller(authedCtx(100, true) as never);
    const res = await caller.devTunnelStatus({ blockId: 'my-app' });
    expect(res).toMatchObject({ active: true, host: 'dev-0123456789abcdef.civit.ai' });
  });
});
