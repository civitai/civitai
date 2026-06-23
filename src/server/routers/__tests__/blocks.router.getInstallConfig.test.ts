import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for `blocks.getInstallConfig` — the authenticated source the install
 * modal (AppSettingsModal) uses for the publisher-settings form + declared
 * scopes, keyed on appBlockId.
 *
 * It exists because the anon-capable marketplace listing (`listAvailable`)
 * projects each manifest down to a PUBLIC allowlist (name/description/targets
 * only) — so `settings`/`scopes` are NOT available from a marketplace card.
 * This proc returns ONLY those install-needed bits and is gated to the SAME
 * audience that can install (moderatorProcedure today). These tests assert:
 *   - it returns the manifest's settings meta + declared scopes for an approved
 *     app,
 *   - it 404s for a non-approved (or missing) app — never leaks an unapproved
 *     manifest,
 *   - it is mod-gated: a non-mod and an anon caller are both DENIED (would FAIL
 *     if the moderatorProcedure gate were dropped to public/protected).
 *
 * The service layer (BlockRegistry) is mocked at the module boundary; this
 * suite exercises the router's auth gate, approved gate, and projection.
 */

const {
  mockIsAppBlocksEnabled,
  mockDbReadAppBlockFindUnique,
  mockGetUserBuzzAccounts,
} = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  mockDbReadAppBlockFindUnique: vi.fn(),
  mockGetUserBuzzAccounts: vi.fn(async () => ({ yellow: 0, blue: 0, green: 0 })),
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
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: mockDbReadAppBlockFindUnique } },
  dbWrite: { modelBlockInstall: { findUnique: vi.fn() }, model: { findUnique: vi.fn() } },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
  REDIS_KEYS: { BLOCKS: {} },
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/textToImage/textToImage', () => ({
  createTextToImageStep: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: mockGetUserBuzzAccounts,
}));
// The E1 router imports `rateLimit` from middleware.trpc, which transitively
// pulls in user-preferences.service → caches.ts → tag.selector (a top-level
// `Prisma.validator(...)` call). In a fresh worktree the generated Prisma client
// can't be produced (NixOS engine fetch), so evaluating that chain throws at
// import time. Mock middleware.trpc with a pass-through `rateLimit` middleware
// (built from the real, lightweight `middleware` factory) to cut the chain —
// rate-limiting isn't under test here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: () => middleware(({ next }) => next()),
  };
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
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

function anonCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false, isBlue: false, isGreen: false, isGreenSession: false } as never,
    track: undefined,
  };
}

const APPROVED_MANIFEST = {
  name: 'Generate from model',
  description: 'one-click gen',
  scopes: ['ai:write:budgeted', 'models:read:self'],
  // Internal/server-set fields that must never reach the install form — proves
  // the projection drops everything except settings + scopes.
  trustTier: 'trusted',
  iframe: { src: 'https://internal-host.example/secret' },
  settings: {
    buzz_budget_per_gen: {
      type: 'number',
      scope: 'publisher',
      label: 'Buzz budget per generation',
      description: 'Max Buzz spent per generation',
      min: 0,
      max: 1000,
    },
  },
};

beforeEach(() => {
  mockDbReadAppBlockFindUnique.mockReset();
  mockIsAppBlocksEnabled.mockReset();
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
});

describe('blocks.getInstallConfig', () => {
  it('returns settings meta + approved scopes for an approved app (and nothing else)', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      manifest: APPROVED_MANIFEST,
      approvedScopes: ['ai:write:budgeted', 'models:read:self'],
    });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_x' });

    expect(out.scopes).toEqual(['ai:write:budgeted', 'models:read:self']);
    expect(Object.keys(out.settings)).toEqual(['buzz_budget_per_gen']);
    // The settings field round-trips through the meta schema with its range.
    expect(out.settings.buzz_budget_per_gen).toMatchObject({
      type: 'number',
      scope: 'publisher',
      min: 0,
      max: 1000,
    });
    // Internal/private manifest fields are NOT part of the returned shape.
    expect(out).not.toHaveProperty('trustTier');
    expect(out).not.toHaveProperty('iframe');
    expect(out).not.toHaveProperty('name');
  });

  // H3 disclosure correctness: the install modal shows these scopes at the
  // authorization moment, so they MUST equal the mint ceiling (manifest ∩
  // approvedScopes), NOT the raw self-declared manifest. A scope the mod did
  // NOT approve will never be minted — disclosing it would over-state, and an
  // internal/unapproved scope id the manifest declares must not leak. Mirrors
  // grantScopes' ceiling + getAppDetail's approved-only projection.
  it('discloses only manifest ∩ approvedScopes — drops mod-narrowed/unapproved scopes', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      manifest: {
        name: 'overclaiming app',
        scopes: ['ai:write:budgeted', 'models:read:self', 'social:tip:self', 'INTERNAL_secret'],
      },
      // The moderator narrowed approval to a subset; the other two are NOT granted.
      approvedScopes: ['ai:write:budgeted', 'models:read:self'],
    });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_overclaim' });
    expect(out.scopes).toEqual(['ai:write:budgeted', 'models:read:self']);
    expect(out.scopes).not.toContain('social:tip:self');
    expect(out.scopes).not.toContain('INTERNAL_secret');
  });

  it('returns empty scopes when approvedScopes is empty even if the manifest declares some', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      manifest: { name: 'pending-approval', scopes: ['ai:write:budgeted'] },
      approvedScopes: [],
    });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_unapproved_scopes' });
    expect(out.scopes).toEqual([]);
  });

  it('returns empty settings + empty scopes for an approved app with no declarations', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      manifest: { name: 'who-am-i' },
    });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_whoami' });
    expect(out).toEqual({ settings: {}, scopes: [] });
  });

  it('404s for a non-approved app — never returns its manifest', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'pending',
      manifest: APPROVED_MANIFEST,
    });
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await expect(caller.getInstallConfig({ appBlockId: 'ab_pending' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('404s for a missing app', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue(null);
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    await expect(caller.getInstallConfig({ appBlockId: 'ab_missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // SECURITY: the gate. Layer 1 widened getInstallConfig moderatorProcedure →
  // protectedProcedure (keeping enforceAppBlocksFlag), so the live control is the
  // mod-segmented appBlocks flag, NOT a hardcoded isModerator belt. For a non-mod
  // / anon caller the flag is OFF today → enforceAppBlocksFlag marks the query
  // disabled → the proc fail-soft returns empty config and the manifest lookup
  // never runs (nothing leaks pre-launch). These tests model the live (dark) flag
  // by resolving it from the caller's mod status, mirroring the production rule.
  function fakePerUserFlag(opts?: { user?: { isModerator?: boolean } }) {
    return Promise.resolve(!!opts?.user?.isModerator);
  }

  it('non-mod authed caller, flag dark (live): empty config — manifest lookup never runs', async () => {
    mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
    const caller = blocksRouter.createCaller(authedCtx(7, false) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_x' });
    expect(out).toEqual({ settings: {}, scopes: [] });
    expect(mockDbReadAppBlockFindUnique).not.toHaveBeenCalled();
  });

  it('anon caller → UNAUTHORIZED (protectedProcedure auth gate) — manifest lookup never runs', async () => {
    // getInstallConfig is now protectedProcedure, so the auth middleware rejects
    // an anon caller (UNAUTHORIZED) BEFORE enforceAppBlocksFlag even runs — there
    // is no logged-in owner/installer to serve. The manifest never loads.
    mockIsAppBlocksEnabled.mockImplementation(fakePerUserFlag);
    const caller = blocksRouter.createCaller(anonCtx() as never);
    await expect(caller.getInstallConfig({ appBlockId: 'ab_x' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDbReadAppBlockFindUnique).not.toHaveBeenCalled();
  });

  // Layer 1 launch behavior (post Flipt segment widen): once the flag is ON for a
  // non-mod, getInstallConfig serves them the SAME approved-only install config a
  // mod gets — proving it is owner-/installer-capable, not mod-gated. The
  // approved + manifest∩approvedScopes projection is unchanged (still no leak).
  it('non-mod authed caller WITH the flag lit: returns the approved install config', async () => {
    mockIsAppBlocksEnabled.mockImplementation(async () => true);
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      manifest: APPROVED_MANIFEST,
      approvedScopes: ['ai:write:budgeted', 'models:read:self'],
    });
    const caller = blocksRouter.createCaller(authedCtx(7, false) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_x' });
    expect(out.scopes).toEqual(['ai:write:budgeted', 'models:read:self']);
    expect(Object.keys(out.settings)).toEqual(['buzz_budget_per_gen']);
    expect(out).not.toHaveProperty('trustTier');
    expect(out).not.toHaveProperty('iframe');
  });

  it('fail-soft returns empty (no manifest lookup) when the appBlocks flag is dark', async () => {
    // getInstallConfig is a query, so enforceAppBlocksFlag marks _appBlocksDisabled
    // rather than throwing. The proc honors that and returns an empty config — the
    // modal renders no settings form rather than erroring, and crucially the
    // manifest lookup never runs (nothing leaks while dark).
    mockIsAppBlocksEnabled.mockImplementation(async () => false);
    const caller = blocksRouter.createCaller(authedCtx(42) as never);
    const out = await caller.getInstallConfig({ appBlockId: 'ab_x' });
    expect(out).toEqual({ settings: {}, scopes: [] });
    expect(mockDbReadAppBlockFindUnique).not.toHaveBeenCalled();
  });
});
