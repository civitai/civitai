import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 `resolveViewerAudienceFloor` — THE COHORT RESOLVER, TESTED DIRECTLY.
 *
 * ── WHY THIS FILE HAD TO EXIST ──────────────────────────────────────────────────
 * The function had NO test of its own, and the three router suites that exercise the
 * read middleware all `vi.mock` it — they replace the very function under discussion with
 * `async () => 'public'`. So a mutation sweep found a one-word change that SURVIVED the
 * entire suite: making the anonymous branch answer `'testers'` instead of `'public'`
 * publishes every `testers`-level draft listing to the anonymous internet. The moderator
 * short-circuit survived too.
 *
 * That is the "verified in isolation" shape — every caller was tested against a fake of
 * this function, so nothing ever ran the real one.
 *
 * ── WHAT A FLOOR IS, BECAUSE THE DIRECTION READS BACKWARDS ──────────────────────
 * The floor is the NARROWEST per-listing level that still admits the viewer, so the
 * LEAST-privileged answer is the WIDEST level — `public`, which admits them only to
 * listings whose owner marked them public. An unknown viewer must floor at `public`;
 * flooring at `moderators` would be the maximal grant.
 *
 * Only `~/server/flipt/client` is faked, and only its `isEnabled` leg, so the real
 * accessor, the real context builder and the real short-circuit all execute.
 */

const { mockIsFlipt } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: (...a: unknown[]) => mockIsFlipt(...a),
  isFliptSync: () => null,
}));
// 🔴 NO PER-FILE MOCK OF THE LOGGING CLIENT — it has a canonical shared mock registered in
// the global setup, and `no-direct-shared-module-mock` is the ratchet that stops a new
// direct one being added. Nothing here needs to assert on it.
vi.mock('~/server/prom/store-scope.metrics', () => ({
  recordStoreScopeResolution: vi.fn(),
  recordStoreScopeDivergence: vi.fn(),
  recordPublicCatalogOutcome: vi.fn(),
  recordStoreScopeApplied: vi.fn(),
}));

import { resolveViewerAudienceFloor } from '~/server/services/app-blocks-flag';
import type { SessionUser } from '~/types/session';

const user = (over: Partial<SessionUser> = {}) =>
  ({ id: 42, isModerator: false, tier: 'free', ...over } as SessionUser);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFlipt.mockImplementation(async () => false);
});

describe('resolveViewerAudienceFloor', () => {
  it('[INV] ANONYMOUS floors at `public` — the least-privileged answer', async () => {
    // 🔴 THE MUTANT THAT SURVIVED THE WHOLE SUITE. `'testers'` here hands every
    // testers-level draft listing to the anonymous internet.
    await expect(resolveViewerAudienceFloor()).resolves.toBe('public');
    await expect(resolveViewerAudienceFloor({})).resolves.toBe('public');
    await expect(resolveViewerAudienceFloor({ user: undefined })).resolves.toBe('public');
  });

  it('[INV] anonymous does NOT evaluate a flag at all', async () => {
    // A no-user eval returns the flag's BASE value rather than denying, so asking a
    // question that cannot refuse would make a base-`enabled` flip lift every anonymous
    // viewer. The branch must answer directly instead.
    await resolveViewerAudienceFloor();
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('[NEW] a MODERATOR floors at `moderators`, without evaluating a flag', async () => {
    // The short-circuit is the server-stamped session flag, deliberately not a flag eval:
    // a moderator is typically outside every cohort segment, so requiring a flag would
    // refuse the audience the `moderators` level exists for. Its mutant survived too.
    await expect(resolveViewerAudienceFloor({ user: user({ isModerator: true }) })).resolves.toBe(
      'moderators'
    );
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('[NEW] a logged-in viewer IN the cohort floors at `testers`', async () => {
    mockIsFlipt.mockImplementation(async () => true);
    await expect(resolveViewerAudienceFloor({ user: user() })).resolves.toBe('testers');
  });

  it('[NEW] a logged-in viewer OUTSIDE the cohort floors at `public`', async () => {
    mockIsFlipt.mockImplementation(async () => false);
    await expect(resolveViewerAudienceFloor({ user: user() })).resolves.toBe('public');
  });

  it('[INV] it evaluates the APP-BLOCKS flag, per-user, with a real context', async () => {
    // Pins WHICH flag carries the cohort. `app-blocks-enabled` is the runtime gate that
    // stays cohort-segmented; `app-listings` is the SURFACE flag that widens to public at
    // GA. Reading the cohort off the surface flag would make `testers` collapse into
    // `public` the moment the store goes public — the distinction the enum exists to draw.
    mockIsFlipt.mockImplementation(async () => true);
    await resolveViewerAudienceFloor({ user: user({ id: 7 }) });
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
    const [flag, entityId, context] = mockIsFlipt.mock.calls[0] as [string, string, object];
    expect(flag).toBe('app-blocks-enabled');
    // Per-user, or no segment can ever match (the eval would carry entityId 'global' and
    // an empty context).
    expect(entityId).toBe('7');
    expect(context).toMatchObject({ userId: '7', isModerator: 'false' });
  });

  it('[INV] an unreachable Flipt floors at `public`, not at a cohort', async () => {
    // `isFlipt` returns `false` when the client is null and when the evaluation throws, so
    // the degraded answer is the least-privileged one. Asserted rather than assumed,
    // because this is the state a Flipt outage produces in production.
    mockIsFlipt.mockImplementation(async () => {
      throw new Error('flipt unreachable');
    });
    await expect(resolveViewerAudienceFloor({ user: user() })).rejects.toThrow();
    // ...and with the real client's own swallow in place (it returns false rather than
    // throwing), the resolver answers `public`:
    mockIsFlipt.mockImplementation(async () => false);
    await expect(resolveViewerAudienceFloor({ user: user() })).resolves.toBe('public');
  });

  it('[INV] every answer is a real audience floor, never `private`', async () => {
    // `private` admits nobody, so it is not a floor — a resolver that returned it would
    // make the comparison in `viewerSeesListingVisibility` admit a viewer to every level.
    for (const impl of [true, false]) {
      mockIsFlipt.mockImplementation(async () => impl);
      for (const u of [undefined, user(), user({ isModerator: true })]) {
        const floor = await resolveViewerAudienceFloor(u ? { user: u } : undefined);
        expect(['moderators', 'testers', 'public']).toContain(floor);
      }
    }
  });
});
