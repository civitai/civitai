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

const { mockIsAppBlocksEnabled, mockGetUserBuzzAccounts } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
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
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.set.mockImplementation(async () => undefined);
const mockDbReadAppBlockFindUnique = dbMock.dbRead.appBlock.findUnique;

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

  // H3 disclosure correctness: the install modal shows these scopes at the authorization
  // moment, so they MUST equal `manifest.scopes ∩ approvedScopes` — the shared
  // `effectiveBlockScopes` rule — and NOT the raw self-declared manifest. Disclosing a scope
  // outside the approval would over-state what the user is consenting to, and an
  // internal/unapproved scope id the manifest declares must not leak.
  //
  // ⚠️ DO NOT CALL THAT SET "THE MINT CEILING" — an earlier revision of this comment did, and it
  // is the same false mint model retracted at `src/shared/constants/block-effective-scopes.ts`.
  // No mint computes this intersection: the PRODUCTION mint
  // (`src/pages/api/v1/block-tokens/index.ts:1054`) signs the MANIFEST filtered to the known
  // vocabulary and uses `approvedScopes` only as an all-or-nothing 403 veto; the two dev-tunnel
  // mints source `app.scopes` (`:469`, `resolveDevPageBlockForAuthor`) and `app.approvedScopes`
  // (`:650`, `resolveOwnedNonApprovedPageBlock`) respectively.
  //
  // What this set DOES mirror is `grantScopes`' consent ceiling — same helper, same module,
  // asserted in "the approved-scope consent ceiling" block below. It does NOT mirror
  // `getAppDetail`/`scopesSummary`, which project RAW `approved_scopes` with no intersection at
  // all; that is deliberate for the public pre-launch disclosure. See the retraction at
  // `src/server/routers/blocks.router.ts` (the `getInstallConfig` call site).
  it('discloses only manifest ∩ approvedScopes — drops scopes outside the approval', async () => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      manifest: {
        name: 'overclaiming app',
        scopes: ['ai:write:budgeted', 'models:read:self', 'social:tip:self', 'INTERNAL_secret'],
      },
      // A STALE-WIDER MANIFEST, not a moderator narrowing — there is no per-scope narrowing
      // mechanism. The approve paths write `approvedScopes = manifestScopes` verbatim
      // (`publish-request.service.ts`), so the only way the two diverge like this is a later
      // publisher push: `src/pages/api/v1/developer/block-manifests.ts` replaces `manifest` and
      // sets `status:'pending'` without touching `approved_scopes`. The other two are NOT granted.
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

/**
 * `blocks.grantScopes` — the CONSENT BUDGET write half.
 *
 * 🔴 THIS IS A SEAM TEST, AND THAT IS WHY IT EXISTS. The enforcement side
 * (`blocks.router.scopeEnforcement.test.ts`) mocks the grant READ directly, and the
 * service side (`scope-grant.service.test.ts`) mocks the DB. Both are hermetic and both
 * pass whether or not the two halves are wired together — nothing in either builds the
 * combined state. What is asserted here is the RELATIONSHIP: the value `grantScopes`
 * hands to the write path is the same shape `getConsentBuzzBudget` reads back, so a
 * budget the user sets can actually reach the spend path.
 *
 * The budget is meaningful only alongside `ai:write:budgeted` — nothing else in the
 * vocabulary can spend — so a budget sent without it is IGNORED rather than rejected.
 * See the call site for why ignoring beats erroring.
 */
/**
 * ctx with the appBlocks feature on (the proc gates on `ctx.features.appBlocks`).
 *
 * Module-scoped because BOTH `grantScopes` describes below need it. A `function` declared inside a
 * `describe` callback is scoped to that callback, so the second block could not see the first one's
 * copy and carried a byte-identical duplicate.
 */
function consentCtx(userId = 42) {
  const ctx = authedCtx(userId, false) as unknown as { features: Record<string, unknown> };
  ctx.features = { ...ctx.features, appBlocks: true };
  return ctx;
}

describe('blocks.grantScopes — consent budget', () => {
  const grantMock = dbMock.dbWrite.appUserScopeGrant;

  beforeEach(() => {
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      version: '1.2.3',
      manifest: APPROVED_MANIFEST,
      approvedScopes: ['ai:write:budgeted', 'models:read:self'],
    });
    grantMock.findUnique.mockReset();
    grantMock.create.mockReset();
    grantMock.update.mockReset();
    grantMock.findUnique.mockResolvedValue(null); // no prior grant
    grantMock.create.mockResolvedValue({});
    grantMock.update.mockResolvedValue({});
  });

  it('PERSISTS the budget when ai:write:budgeted is among the granted scopes', async () => {
    const caller = blocksRouter.createCaller(consentCtx() as never);
    const out = await caller.grantScopes({
      appBlockId: 'ab_x',
      scopes: ['ai:write:budgeted'],
      buzzBudgetPerDay: 750,
    });
    expect(out.granted).toEqual(['ai:write:budgeted']);
    // The number reached the WRITE, under the column name the read selects.
    expect(grantMock.create.mock.calls[0][0].data).toMatchObject({ buzzBudgetPerDay: 750 });
    // ...and the response echoes what was stored, so a client needs no second round-trip.
    expect(out.buzzBudgetPerDay).toBe(750);
  });

  it('IGNORES a budget sent without any spend scope (does not error, stores nothing)', async () => {
    const caller = blocksRouter.createCaller(consentCtx() as never);
    const out = await caller.grantScopes({
      appBlockId: 'ab_x',
      scopes: ['models:read:self'],
      buzzBudgetPerDay: 750,
    });
    expect(out.granted).toEqual(['models:read:self']);
    // The KEY is absent, not null: an explicit null would CLEAR a stored budget, and
    // "ignore" must not double as "erase".
    const data = grantMock.create.mock.calls[0][0].data;
    expect(Object.hasOwn(data, 'buzzBudgetPerDay')).toBe(false);
    expect(out.buzzBudgetPerDay).toBeUndefined();
  });

  it('HONOURS a budget for an app that ALREADY holds the spend scope', async () => {
    // Raising a limit on an app you consented to earlier: the scope is not in THIS
    // call's grant, so the meaningfulness test has to consult the stored grant.
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: ['ai:write:budgeted'],
      revokedAt: null,
    });
    const caller = blocksRouter.createCaller(consentCtx() as never);
    const out = await caller.grantScopes({
      appBlockId: 'ab_x',
      scopes: ['models:read:self'],
      buzzBudgetPerDay: 300,
    });
    expect(grantMock.update.mock.calls[0][0].data).toMatchObject({ buzzBudgetPerDay: 300 });
    expect(out.buzzBudgetPerDay).toBe(300);
  });

  it('OMITTING the budget leaves a stored one untouched', async () => {
    grantMock.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: ['ai:write:budgeted'],
      revokedAt: null,
    });
    const caller = blocksRouter.createCaller(consentCtx() as never);
    await caller.grantScopes({ appBlockId: 'ab_x', scopes: ['models:read:self'] });
    const data = grantMock.update.mock.calls[0][0].data;
    expect(Object.hasOwn(data, 'buzzBudgetPerDay')).toBe(false);
  });

  it('REJECTS a budget above the platform daily cap at the input boundary', async () => {
    const caller = blocksRouter.createCaller(consentCtx() as never);
    await expect(
      caller.grantScopes({
        appBlockId: 'ab_x',
        scopes: ['ai:write:budgeted'],
        buzzBudgetPerDay: BLOCK_BUZZ_CAP_PER_DAY + 1,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(grantMock.create).not.toHaveBeenCalled();
  });

  it('REJECTS a zero budget (declining the scope is how you express "never")', async () => {
    const caller = blocksRouter.createCaller(consentCtx() as never);
    await expect(
      caller.grantScopes({
        appBlockId: 'ab_x',
        scopes: ['ai:write:budgeted'],
        buzzBudgetPerDay: 0,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(grantMock.create).not.toHaveBeenCalled();
  });
});

/**
 * `blocks.grantScopes` — THE CONSENT CEILING (`manifest.scopes ∩ approvedScopes`).
 *
 * 🔴 WHY THIS BLOCK EXISTS. This is the ONE site in the codebase that decides what a user can
 * CONSENT TO, and until this block it had NO behavioural coverage at all. Measured on the
 * pre-existing suite: replacing the ceiling with the RAW MANIFEST — the WIDENING direction, i.e.
 * ignoring `approvedScopes` entirely — left the file at 16/16 passed, byte-identical to HEAD. The
 * reason was fixture shape, not a missing assertion: every `grantScopes` fixture above uses a
 * manifest and an approval that OVERLAP on the scope under test, so no fixture could distinguish
 * "intersected with the approval" from "took the manifest". The ceiling's own error string
 * appeared in 0 of 1994 test files.
 *
 * So both cases below deliberately use `manifest ⊋ approved` — a stale-wider manifest, which is
 * reachable via `src/pages/api/v1/developer/block-manifests.ts` (it replaces `manifest` and sets
 * `status:'pending'` without touching `approved_scopes`). Each one FAILS under the raw-manifest
 * widening mutant, on its own assertion.
 */
describe('blocks.grantScopes — the approved-scope consent ceiling', () => {
  const grantMock = dbMock.dbWrite.appUserScopeGrant;

  beforeEach(() => {
    // manifest ⊋ approved: `social:tip:self` is DECLARED but was never approved. It is a
    // real, sensitive, spend-adjacent scope, not a synthetic id — the over-grant this gate
    // exists to stop.
    mockDbReadAppBlockFindUnique.mockResolvedValue({
      status: 'approved',
      version: '2.0.0',
      manifest: {
        name: 'stale-wider manifest',
        scopes: ['models:read:self', 'social:tip:self'],
      },
      approvedScopes: ['models:read:self'],
    });
    grantMock.findUnique.mockReset();
    grantMock.create.mockReset();
    grantMock.update.mockReset();
    grantMock.findUnique.mockResolvedValue(null);
    grantMock.create.mockResolvedValue({});
    grantMock.update.mockResolvedValue({});
  });

  it('🔴 DROPS a declared-but-unapproved scope from the grant, and never writes it', async () => {
    const caller = blocksRouter.createCaller(consentCtx() as never);
    const out = await caller.grantScopes({
      appBlockId: 'ab_stale_wider',
      scopes: ['models:read:self', 'social:tip:self'],
    });
    // The response must not claim the user consented to something outside the approval…
    expect(out.granted).toEqual(['models:read:self']);
    expect(out.granted).not.toContain('social:tip:self');
    // …and the unapproved scope must not reach the PERSISTED grant either, which is what the
    // enforcement path later reads back.
    const written = grantMock.create.mock.calls[0][0].data;
    expect(written.grantedScopes).toEqual(['models:read:self']);
    expect(written.grantedScopes).not.toContain('social:tip:self');
  });

  it('🔴 REFUSES outright when EVERY requested scope is outside the approval', async () => {
    const caller = blocksRouter.createCaller(consentCtx() as never);
    await expect(
      caller.grantScopes({ appBlockId: 'ab_stale_wider', scopes: ['social:tip:self'] })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      // Pinned as the literal the call site emits — it appeared in no test file before this one,
      // so a reworded or relocated ceiling check had nothing asserting it.
      message: 'none of the requested scopes are within the app’s approved manifest',
    });
    expect(grantMock.create).not.toHaveBeenCalled();
    expect(grantMock.update).not.toHaveBeenCalled();
  });
});
