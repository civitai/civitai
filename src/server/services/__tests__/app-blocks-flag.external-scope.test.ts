import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * EXTERNAL-ONLY store scope — the segment-capable `app-listings-public-external`
 * flag and the `resolveStoreVisibilityScope` priority order it feeds.
 *
 * WHAT CHANGED AND WHY IT MATTERS: `isExternalListingsPublicEnabled` used to be a
 * bare `isFlipt(FLAG)` — a GLOBAL eval (entityId='global', empty context). A Flipt
 * SEGMENT can only match on the context it is handed, so a `testers` segment on
 * that flag resolved `false` for every member of the cohort and the whole feature
 * was unreachable by construction. It now evaluates PER-USER when a user is
 * present, exactly like `isAppBlocksEnabled` / `isAppListingsEnabled`.
 *
 * Two properties are load-bearing and are pinned separately below:
 *   1. BACKWARD COMPATIBILITY — with NO user the call must be byte-identical to
 *      the old global eval, and a BASE-ENABLED flag must still resolve true for
 *      everyone. Adding context may only ADD segmentation, never narrow.
 *   2. PRIORITY ORDER — the privileged axis is checked FIRST, so a moderator who
 *      also falls inside the external cohort still resolves `full` and is never
 *      NARROWED to `public-external`.
 *
 * `isFlipt` is mocked with a faithful re-implementation of how a real Flipt boolean
 * flag evaluates (base value + optional segment rollout matched against the eval
 * context), so the assertions mirror production wiring rather than the helper's own
 * branches. `buildFliptContext` is the REAL function — the same one the CLIENT gate
 * uses, which is the anti-drift mechanism this whole seam rests on.
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
}));

import {
  APP_LISTINGS_PUBLIC_EXTERNAL_FLAG,
  isExternalListingsPublicEnabled,
  resolveStoreVisibilityScope,
} from '../app-blocks-flag';
import { buildFliptContext } from '../feature-flags.service';

const EXTERNAL = APP_LISTINGS_PUBLIC_EXTERNAL_FLAG;

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return { id: 123, username: 'u', isModerator: false, tier: 'free', ...over } as SessionUser;
}

/**
 * A faithful stand-in for ONE Flipt boolean flag.
 *
 * Real Flipt evaluates rollouts in order and falls back to the flag's base
 * `enabled` when none match — that is precisely why a base-enabled flag is immune
 * to the entityId/context you hand it, and why a segmented one is not. Modelling
 * both shapes (rather than a bare boolean) is what lets the backward-compatibility
 * assertions below mean anything.
 */
type FlagShape =
  | { kind: 'absent' }
  | { kind: 'base'; enabled: boolean }
  | { kind: 'segment'; base: boolean; match: (ctx: Record<string, string>) => boolean };

let flags: Record<string, FlagShape>;

// Tuple params with a destructuring HOLE for entityId: these shapes are all
// context-driven (that is the point — a segment matches on context, not on the
// entity), so entityId is deliberately unread rather than named-and-ignored.
function evaluate(
  ...args: [flag: string, entityId?: string, context?: Record<string, string>]
): boolean {
  const [flag, , ctxArg] = args;
  const context = ctxArg ?? {};
  const shape = flags[flag] ?? { kind: 'absent' };
  // Absent flag / Flipt down: the real async `isFlipt` swallows the error and
  // returns false. Fail-closed.
  if (shape.kind === 'absent') return false;
  if (shape.kind === 'base') return shape.enabled;
  return shape.match(context) ? true : shape.base;
}

/** The tester cohort segment: a userId allowlist, matched off the eval context. */
const TESTERS = new Set(['777', '778']);
const testerSegment: FlagShape = {
  kind: 'segment',
  base: false,
  match: (ctx) => typeof ctx.userId === 'string' && TESTERS.has(ctx.userId),
};

beforeEach(() => {
  flags = {};
  mockIsFlipt.mockReset();
  mockIsFlipt.mockImplementation(async (...args: Parameters<typeof evaluate>) => evaluate(...args));
});

// ---------------------------------------------------------------------------
// 1. The user-aware eval
// ---------------------------------------------------------------------------

describe('isExternalListingsPublicEnabled — user-aware eval (segment-capable)', () => {
  it('🔴 a SEGMENT-scoped flag matches for an IN-segment user', async () => {
    flags[EXTERNAL] = testerSegment;
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 777 }) })).resolves.toBe(
      true
    );
  });

  it('🔴 …and does NOT match for an OUT-of-segment user', async () => {
    flags[EXTERNAL] = testerSegment;
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 555 }) })).resolves.toBe(
      false
    );
  });

  it('threads entityId + the SHARED context builder (the arguments the client gate uses)', async () => {
    flags[EXTERNAL] = testerSegment;
    const user = makeUser({ id: 777 });
    await isExternalListingsPublicEnabled({ user });
    // Not `objectContaining`: the seam is that the server passes the EXACT triple
    // the client gate passes. A partial match would pass while the two drifted.
    expect(mockIsFlipt).toHaveBeenCalledWith(EXTERNAL, '777', buildFliptContext(user));
  });

  it('a segment keyed on isModerator matches off the SERVER-side flag, not a spoofed field', async () => {
    flags[EXTERNAL] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.isModerator === 'true',
    };
    const user = makeUser({ id: 555, isModerator: false });
    (user as unknown as Record<string, unknown>).is_moderator = 'true';
    await expect(isExternalListingsPublicEnabled({ user })).resolves.toBe(false);
  });

  it('reads ONLY the app-listings-public-external key', async () => {
    flags[EXTERNAL] = testerSegment;
    await isExternalListingsPublicEnabled({ user: makeUser({ id: 777 }) });
    for (const call of mockIsFlipt.mock.calls) expect(call[0]).toBe(EXTERNAL);
  });
});

describe('isExternalListingsPublicEnabled — BACKWARD COMPATIBILITY (no user)', () => {
  it('🔴 no user → the ORIGINAL global eval, byte-identical (flag key alone)', async () => {
    flags[EXTERNAL] = { kind: 'base', enabled: false };
    await isExternalListingsPublicEnabled();
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
    // Exactly one argument — entityId + context fall back to the client's
    // ('global', {}) defaults, which is what the pre-change call did.
    expect(mockIsFlipt).toHaveBeenCalledWith(EXTERNAL);
    mockIsFlipt.mockClear();
    await isExternalListingsPublicEnabled({ user: undefined });
    expect(mockIsFlipt).toHaveBeenCalledWith(EXTERNAL);
  });

  it('🔴 a BASE-ENABLED flag still resolves TRUE for everyone — context only ADDS', async () => {
    // The no-narrowing invariant. A plain base-`enabled` boolean has no rollout
    // rules, so it is immune to whatever entityId/context the eval carries: the
    // anonymous global path, an in-cohort user and a random user must ALL be true.
    flags[EXTERNAL] = { kind: 'base', enabled: true };
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(true);
    await expect(isExternalListingsPublicEnabled({ user: undefined })).resolves.toBe(true);
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 777 }) })).resolves.toBe(
      true
    );
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 555 }) })).resolves.toBe(
      true
    );
    await expect(
      isExternalListingsPublicEnabled({ user: makeUser({ id: 1, isModerator: true }) })
    ).resolves.toBe(true);
  });

  it('a base-DISABLED flag stays false everywhere (base value is the fallback)', async () => {
    flags[EXTERNAL] = { kind: 'base', enabled: false };
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 777 }) })).resolves.toBe(
      false
    );
  });

  it('a SEGMENTED flag cannot match on the no-user path (anon stays dark this phase)', async () => {
    flags[EXTERNAL] = testerSegment;
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    await expect(isExternalListingsPublicEnabled({ user: undefined })).resolves.toBe(false);
  });

  it('fail-closed: absent flag / Flipt down → false, user or not', async () => {
    // `flags` is empty → every key is `absent` → the real async isFlipt's
    // catch-and-return-false path.
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 777 }) })).resolves.toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// 2. resolveStoreVisibilityScope — the full matrix
// ---------------------------------------------------------------------------

/**
 * The scope resolver over all three keys at once. `app-blocks-enabled` is modelled
 * as the live mod segment, `app-listings` as a per-user tester grant, and
 * `app-listings-public-external` as whatever the case under test configures.
 */
describe('resolveStoreVisibilityScope — the external-only matrix', () => {
  const MOD_SEGMENT: FlagShape = {
    kind: 'segment',
    base: false,
    match: (ctx) => ctx.isModerator === 'true',
  };

  beforeEach(() => {
    flags['app-blocks-enabled'] = MOD_SEGMENT;
    // `app-listings` grants the app-dev-testers cohort (id 888 here).
    flags['app-listings'] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.userId === '888',
    };
  });

  it('privileged: a MODERATOR resolves full', async () => {
    await expect(
      resolveStoreVisibilityScope({ user: makeUser({ id: 1, isModerator: true }) })
    ).resolves.toBe('full');
  });

  it('privileged: an app-listings TESTER resolves full', async () => {
    await expect(resolveStoreVisibilityScope({ user: makeUser({ id: 888 }) })).resolves.toBe(
      'full'
    );
  });

  it('non-privileged + external flag ON (in segment) → public-external', async () => {
    flags[EXTERNAL] = testerSegment;
    await expect(resolveStoreVisibilityScope({ user: makeUser({ id: 777 }) })).resolves.toBe(
      'public-external'
    );
  });

  it('🔴 non-privileged + external flag SEGMENTED but user OUT of segment → none', async () => {
    // The case a global eval could never distinguish — and the reason the helper
    // had to become user-aware. If the eval ignored its user, every non-privileged
    // viewer would get the in-segment answer.
    flags[EXTERNAL] = testerSegment;
    await expect(resolveStoreVisibilityScope({ user: makeUser({ id: 555 }) })).resolves.toBe(
      'none'
    );
  });

  it('non-privileged + external flag OFF → none', async () => {
    flags[EXTERNAL] = { kind: 'base', enabled: false };
    await expect(resolveStoreVisibilityScope({ user: makeUser({ id: 555 }) })).resolves.toBe(
      'none'
    );
  });

  it('no user → unchanged global behaviour (base-enabled lifts, segmented does not)', async () => {
    flags[EXTERNAL] = testerSegment;
    await expect(resolveStoreVisibilityScope()).resolves.toBe('none');
    await expect(resolveStoreVisibilityScope({ user: undefined })).resolves.toBe('none');
    flags[EXTERNAL] = { kind: 'base', enabled: true };
    await expect(resolveStoreVisibilityScope()).resolves.toBe('public-external');
    await expect(resolveStoreVisibilityScope({ user: undefined })).resolves.toBe('public-external');
  });

  it('🔴 A MODERATOR IN THE EXTERNAL COHORT IS STILL `full`, NEVER NARROWED', async () => {
    // The regression the priority order exists to prevent. A mod who is ALSO a
    // member of the tester segment must keep the whole catalog — if the external
    // axis were checked first they would silently lose every onsite listing.
    flags[EXTERNAL] = {
      kind: 'segment',
      base: false,
      // Matches EVERY logged-in user, moderators included — the worst case.
      match: (ctx) => ctx.isLoggedIn === 'true',
    };
    await expect(
      resolveStoreVisibilityScope({ user: makeUser({ id: 1, isModerator: true }) })
    ).resolves.toBe('full');
    await expect(resolveStoreVisibilityScope({ user: makeUser({ id: 888 }) })).resolves.toBe(
      'full'
    );
    // …and the same config DOES lift a non-privileged viewer, so the assertion
    // above is not passing because the external flag was simply off.
    await expect(resolveStoreVisibilityScope({ user: makeUser({ id: 555 }) })).resolves.toBe(
      'public-external'
    );
  });

  it('🔴 the external flag is never even EVALUATED for a privileged viewer', async () => {
    flags[EXTERNAL] = { kind: 'base', enabled: true };
    await resolveStoreVisibilityScope({ user: makeUser({ id: 1, isModerator: true }) });
    for (const call of mockIsFlipt.mock.calls) expect(call[0]).not.toBe(EXTERNAL);
  });

  it('reads ONLY the three store keys', async () => {
    flags[EXTERNAL] = { kind: 'base', enabled: true };
    await resolveStoreVisibilityScope({ user: makeUser({ id: 555 }) });
    for (const call of mockIsFlipt.mock.calls) {
      expect(['app-listings', 'app-blocks-enabled', EXTERNAL]).toContain(call[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. DARK BY DEFAULT — the as-merged state
// ---------------------------------------------------------------------------

/**
 * 🔴 THE SHIP-SAFETY PROOF. `app-listings-public-external` does not exist in Flipt
 * today. This models EXACTLY that (`flags` holds only the two flags that DO exist)
 * and asserts every cohort lands where it lands today: mods/testers `full`,
 * everyone else `none`. If this file's other changes ever leak an observable
 * difference into the as-merged state, this goes red.
 */
describe('🔴 DARK BY DEFAULT — flag ABSENT from Flipt (the as-merged state)', () => {
  beforeEach(() => {
    flags['app-blocks-enabled'] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.isModerator === 'true',
    };
    flags['app-listings'] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.userId === '888',
    };
    // `app-listings-public-external` deliberately NOT registered.
  });

  it('the external flag really is absent (control — else every case below is vacuous)', async () => {
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    await expect(isExternalListingsPublicEnabled({ user: makeUser({ id: 777 }) })).resolves.toBe(
      false
    );
  });

  const cohorts: Array<[string, SessionUser | undefined, string]> = [
    ['moderator', makeUser({ id: 1, isModerator: true }), 'full'],
    ['app-dev-tester', makeUser({ id: 888 }), 'full'],
    ['plain logged-in user', makeUser({ id: 555 }), 'none'],
    ['would-be external tester', makeUser({ id: 777 }), 'none'],
    ['anonymous', undefined, 'none'],
  ];

  for (const [name, user, expected] of cohorts) {
    it(`${name} → ${expected}`, async () => {
      await expect(resolveStoreVisibilityScope({ user })).resolves.toBe(expected);
    });
  }

  it('no-arg call is dark too', async () => {
    await expect(resolveStoreVisibilityScope()).resolves.toBe('none');
  });
});
