import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 THE DETECTION NET (civitai#3983 item B) — make a silent store gate LOUD.
 *
 * `resolveStoreVisibilityScope` returning `none` renders as an ordinary empty grid,
 * so a mis-gated cohort is indistinguishable from an empty catalog. The whole of the
 * #3983 investigation was spent unable to separate those two from outside. This suite
 * pins the signal that separates them from INSIDE:
 *
 *   1. every resolution is counted by (scope, principal) — the permanent replacement
 *      for the one-off "instrumented deploy" that would otherwise be needed to ask
 *      "what is production resolving for a logged-in viewer?";
 *   2. the IMPOSSIBLE COMBINATION — the async read path says `none` while the SYNC
 *      evaluation the `/apps` page gate uses says the same viewer holds a store flag —
 *      is counted and logged, per offending flag.
 *
 * The two evaluations are asserted as a RELATIONSHIP (they must agree for one
 * principal), not as two independently-correct components: that is the seam the
 * existing suites each test only one side of.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const { asyncFlags, syncFlags } = vi.hoisted(() => ({
  asyncFlags: { value: {} as Record<string, boolean> },
  syncFlags: { value: {} as Record<string, boolean | null> },
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) => asyncFlags.value[flag] ?? false),
  isFliptSync: vi.fn((flag: string) => syncFlags.value[flag] ?? null),
  getFliptVariant: vi.fn(async () => null),
  getFliptBoolean: vi.fn(async () => false),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { recordStoreScopeResolution, recordStoreScopeDivergence } = vi.hoisted(() => ({
  recordStoreScopeResolution: vi.fn(),
  recordStoreScopeDivergence: vi.fn(),
}));

vi.mock('~/server/prom/store-scope.metrics', () => ({
  recordStoreScopeResolution,
  recordStoreScopeDivergence,
}));

// `~/server/logging/client` has a CANONICAL mock registered in setup.ts — a direct
// per-file `vi.mock` of it would freeze this file's shape into every later file in the
// same worker (`isolate: false`), which is what `no-direct-shared-module-mock` guards.
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const LISTINGS = 'app-listings';
const BLOCKS = 'app-blocks-enabled';
const EXTERNAL = 'app-listings-public-external';

function sessionUser(id: number, extra: Partial<SessionUser> = {}): SessionUser {
  return { id, isModerator: false, tier: 'free', onboarding: 0, ...extra } as SessionUser;
}

beforeEach(() => {
  asyncFlags.value = {};
  syncFlags.value = {};
  vi.clearAllMocks();
});

describe('store-scope resolution counter', () => {
  it('counts an anonymous dark resolution as (none, anon)', async () => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(resolveStoreVisibilityScope()).resolves.toBe('none');
    expect(recordStoreScopeResolution).toHaveBeenCalledWith('none', 'anon');
  });

  it('counts a logged-in privileged resolution as (full, user)', async () => {
    asyncFlags.value = { [LISTINGS]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(resolveStoreVisibilityScope({ user: sessionUser(1) })).resolves.toBe('full');
    expect(recordStoreScopeResolution).toHaveBeenCalledWith('full', 'user');
  });

  it('counts the external-only cohort as (public-external, user)', async () => {
    asyncFlags.value = { [EXTERNAL]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(resolveStoreVisibilityScope({ user: sessionUser(2) })).resolves.toBe(
      'public-external'
    );
    expect(recordStoreScopeResolution).toHaveBeenCalledWith('public-external', 'user');
  });
});

describe('🔴 the impossible combination: page gate admits, read path resolves `none`', () => {
  it('records a divergence naming the flag the sync gate says the viewer holds', async () => {
    // The reported #3983 shape: the viewer reaches /apps because the SYNC evaluation
    // of `app-listings-public-external` says they hold it, and the ASYNC read path
    // resolves `none` anyway.
    asyncFlags.value = {};
    syncFlags.value = { [EXTERNAL]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope({ user: sessionUser(11) })).resolves.toBe('none');

    expect(recordStoreScopeDivergence).toHaveBeenCalledTimes(1);
    expect(recordStoreScopeDivergence).toHaveBeenCalledWith(EXTERNAL);
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom.mock.calls[0][0]).toMatchObject({
      type: 'store-scope-divergence',
      userId: 11,
      heldFlags: [EXTERNAL],
    });
  });

  it('names EVERY disagreeing axis, not just the first', async () => {
    syncFlags.value = { [LISTINGS]: true, [BLOCKS]: true, [EXTERNAL]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope({ user: sessionUser(12) })).resolves.toBe('none');

    expect(recordStoreScopeDivergence.mock.calls.map((c) => c[0]).sort()).toEqual(
      [BLOCKS, LISTINGS, EXTERNAL].sort()
    );
  });

  it('is SILENT when the two evaluations agree the viewer is dark (no false alarm)', async () => {
    syncFlags.value = { [LISTINGS]: false, [BLOCKS]: false, [EXTERNAL]: false };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope({ user: sessionUser(13) })).resolves.toBe('none');

    expect(recordStoreScopeDivergence).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('treats a `null` sync answer (Flipt not initialized) as NOT a divergence', async () => {
    // `isFliptSync` returns null before the client is warm; the documented behaviour
    // is to fall through to static availability, not to report a contradiction.
    syncFlags.value = {};
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope({ user: sessionUser(14) })).resolves.toBe('none');

    expect(recordStoreScopeDivergence).not.toHaveBeenCalled();
  });

  it('does not fire for an ANONYMOUS caller (no page-gate pairing to contradict)', async () => {
    syncFlags.value = { [EXTERNAL]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope()).resolves.toBe('none');

    expect(recordStoreScopeDivergence).not.toHaveBeenCalled();
  });

  it('does not fire when the scope is NOT `none` (only a silent DENY is impossible)', async () => {
    asyncFlags.value = { [EXTERNAL]: true };
    syncFlags.value = { [EXTERNAL]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope({ user: sessionUser(15) })).resolves.toBe(
      'public-external'
    );

    expect(recordStoreScopeDivergence).not.toHaveBeenCalled();
  });

  it('a telemetry failure can NEVER break the read path', async () => {
    recordStoreScopeDivergence.mockImplementation(() => {
      throw new Error('prom exploded');
    });
    syncFlags.value = { [EXTERNAL]: true };
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');

    await expect(resolveStoreVisibilityScope({ user: sessionUser(16) })).resolves.toBe('none');
  });
});
