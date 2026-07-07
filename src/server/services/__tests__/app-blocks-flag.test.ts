import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * H2 — server/client flag-gate divergence.
 *
 * The live Flipt flag `app-blocks-enabled` is base `enabled: false` with a
 * `moderators` segment that matches `isModerator == "true"`. These tests pin
 * the contract that `isAppBlocksEnabled`:
 *   - threads the request user's context into the Flipt eval, so a MODERATOR
 *     resolves ON (the mod canary works server-side);
 *   - keeps a NON-MODERATOR and an ANONYMOUS caller OFF (the no-widening
 *     security invariant);
 *   - preserves the original GLOBAL (no-context) eval for the no-arg machine /
 *     anonymous gates (webhooks, JWKS) — they MUST NOT silently start passing.
 *
 * `isFlipt` is mocked with a faithful re-implementation of how the real flag
 * evaluates so the assertions mirror production wiring rather than the gate's
 * own branches. `buildFliptContext` is the REAL function (the same one the
 * client gate uses) — that shared context builder is the anti-drift mechanism.
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
}));

import {
  isAppBlocksEnabled,
  isAppBlocksAuthorEnabled,
  isAppListingsEnabled,
} from '../app-blocks-flag';

// Faithful stand-in for the live `app-blocks-enabled` rule: base OFF, with a
// `moderators` segment keyed on `context.isModerator === 'true'`. The no-arg
// global eval (entityId='global', empty context) can never match the segment →
// false, exactly as in prod.
function fakeAppBlocksFlag(
  flag: string,
  _entityId = 'global',
  context: Record<string, string> = {}
): boolean {
  if (flag !== 'app-blocks-enabled') return false;
  // moderators segment match
  return context.isModerator === 'true';
}

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return { id: 123, username: 'u', isModerator: false, tier: 'free', ...over } as SessionUser;
}

beforeEach(() => {
  mockIsFlipt.mockReset();
  mockIsFlipt.mockImplementation(async (...args: Parameters<typeof fakeAppBlocksFlag>) =>
    fakeAppBlocksFlag(...args)
  );
});

describe('isAppBlocksEnabled — per-user gate (H2)', () => {
  it('resolves ON for a moderator (mod canary works server-side)', async () => {
    const user = makeUser({ isModerator: true });
    await expect(isAppBlocksEnabled({ user })).resolves.toBe(true);

    // Threaded the user's id as entityId + the mod context — same shape the
    // client gate uses.
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-blocks-enabled',
      '123',
      expect.objectContaining({ isModerator: 'true', userId: '123', isLoggedIn: 'true' })
    );
  });

  it('resolves OFF for a non-moderator (no-widening invariant)', async () => {
    const user = makeUser({ isModerator: false });
    await expect(isAppBlocksEnabled({ user })).resolves.toBe(false);
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-blocks-enabled',
      '123',
      expect.objectContaining({ isModerator: 'false' })
    );
  });

  it('resolves OFF for an anonymous caller (no user → global eval, no segment match)', async () => {
    await expect(isAppBlocksEnabled({ user: undefined })).resolves.toBe(false);
    await expect(isAppBlocksEnabled()).resolves.toBe(false);
  });

  it('uses the SERVER-side isModerator, ignoring a client-spoofed value on the user object', async () => {
    // A non-mod session user cannot become a mod by carrying extra props — the
    // gate only reads `user.isModerator`. (Defense: the SessionUser is built
    // server-side; this asserts the gate never trusts anything but that field.)
    const user = makeUser({ isModerator: false });
    // even if a caller tried to smuggle an isModerator-ish field, only the real
    // SessionUser.isModerator drives buildFliptContext.
    (user as unknown as Record<string, unknown>).is_moderator = 'true';
    await expect(isAppBlocksEnabled({ user })).resolves.toBe(false);
  });
});

describe('isAppBlocksEnabled — machine/anonymous gates stay global (H2 scope)', () => {
  it('no-arg call performs the GLOBAL eval (entityId default, empty context)', async () => {
    await isAppBlocksEnabled();
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
    // Called with only the flag key — entityId + context fall back to the
    // client.ts defaults ('global', {}).
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-enabled');
  });

  it('a globally-enabled flag turns the no-arg gate ON (pipeline global enable path)', async () => {
    // Simulate a future GLOBAL enable: isFlipt returns true regardless of context.
    mockIsFlipt.mockImplementation(async () => true);
    await expect(isAppBlocksEnabled()).resolves.toBe(true);
  });
});

describe('isAppBlocksEnabled — no accidental repoint to the pipeline flag (Decision 1 regression)', () => {
  // The user-facing gate MUST keep reading `app-blocks-enabled`. Decision 1 added
  // a separate `app-blocks-pipeline-enabled` flag for the machine webhooks; this
  // pins that the USER gate never silently moved onto the pipeline key (which
  // would widen the user feature to whatever the global pipeline flag is set to).
  it('per-user mod eval reads ONLY app-blocks-enabled, never app-blocks-pipeline-enabled', async () => {
    const user = makeUser({ isModerator: true });
    await expect(isAppBlocksEnabled({ user })).resolves.toBe(true);
    // The only flag key the user gate ever evaluates is the user-facing one.
    for (const call of mockIsFlipt.mock.calls) {
      expect(call[0]).toBe('app-blocks-enabled');
    }
    expect(mockIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-pipeline-enabled',
      expect.anything(),
      expect.anything()
    );
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-pipeline-enabled');
  });

  it('no-arg eval reads ONLY app-blocks-enabled (never the pipeline / runtime keys)', async () => {
    // The no-arg `isAppBlocksEnabled()` itself still evaluates the user flag.
    // (Decision 4 moved the JWKS / withBlockScope CALLERS onto the dedicated
    // `app-blocks-runtime-enabled` flag — see app-blocks-runtime-flag.test.ts;
    // this asserts the user-flag helper itself never drifts onto another key.)
    await isAppBlocksEnabled();
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-pipeline-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-runtime-enabled');
  });
});

/**
 * Developer soft-launch (Phase B) — the AUTHOR capability helper.
 *
 * `isAppBlocksAuthorEnabled` reads the dedicated `app-blocks-author` Flipt flag
 * (created AFTER merge as base OFF + `moderators` segment + a curated author
 * cohort segment), WITH a static moderator floor so mods never lose their
 * existing author access while the flag is absent / Flipt is down.
 */
// Faithful stand-in for the `app-blocks-author` flag once created: base OFF,
// with a `moderators` segment (isModerator === 'true') AND an author-cohort
// segment (a userId allowlist — here { '777' }).
const AUTHOR_COHORT = new Set(['777']);
function fakeAppBlocksAuthorFlag(
  flag: string,
  _entityId = 'global',
  context: Record<string, string> = {}
): boolean {
  if (flag !== 'app-blocks-author') return false;
  if (context.isModerator === 'true') return true;
  return typeof context.userId === 'string' && AUTHOR_COHORT.has(context.userId);
}

describe('isAppBlocksAuthorEnabled — author capability (developer soft-launch)', () => {
  beforeEach(() => {
    mockIsFlipt.mockReset();
    mockIsFlipt.mockImplementation(async (...args: Parameters<typeof fakeAppBlocksAuthorFlag>) =>
      fakeAppBlocksAuthorFlag(...args)
    );
  });

  it('resolves ON for a moderator via the static floor WITHOUT calling Flipt', async () => {
    const user = makeUser({ isModerator: true });
    await expect(isAppBlocksAuthorEnabled({ user })).resolves.toBe(true);
    // Mod floor short-circuits: the flag is never evaluated (so an absent /
    // mis-segmented flag can't regress mods).
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('resolves ON for a flag-granted cohort user (non-mod)', async () => {
    const user = makeUser({ id: 777, isModerator: false });
    await expect(isAppBlocksAuthorEnabled({ user })).resolves.toBe(true);
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-blocks-author',
      '777',
      expect.objectContaining({ userId: '777', isModerator: 'false' })
    );
  });

  it('resolves OFF for a random non-mod not in the cohort (fail-closed authz)', async () => {
    const user = makeUser({ id: 555, isModerator: false });
    await expect(isAppBlocksAuthorEnabled({ user })).resolves.toBe(false);
  });

  it('resolves OFF for an anonymous / vanished user (no floor, global eval never matches)', async () => {
    await expect(isAppBlocksAuthorEnabled({ user: undefined })).resolves.toBe(false);
    await expect(isAppBlocksAuthorEnabled()).resolves.toBe(false);
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-author');
  });

  it('Flipt-down / flag absent → mods only (static fallback), non-mods denied', async () => {
    // isFlipt returns false for everything (flag absent or Flipt unreachable).
    mockIsFlipt.mockImplementation(async () => false);
    await expect(
      isAppBlocksAuthorEnabled({ user: makeUser({ isModerator: true }) })
    ).resolves.toBe(true); // mod floor
    await expect(
      isAppBlocksAuthorEnabled({ user: makeUser({ id: 777, isModerator: false }) })
    ).resolves.toBe(false); // cohort denied when flag absent
    await expect(
      isAppBlocksAuthorEnabled({ user: makeUser({ id: 555, isModerator: false }) })
    ).resolves.toBe(false);
  });

  it('reads ONLY the app-blocks-author key (never the enabled/pipeline/runtime keys)', async () => {
    await isAppBlocksAuthorEnabled({ user: makeUser({ id: 777, isModerator: false }) });
    for (const call of mockIsFlipt.mock.calls) {
      expect(call[0]).toBe('app-blocks-author');
    }
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
  });
});

/**
 * W13 (PR-W1a / D8) — dedicated App Store VISIBILITY flag with an OR-fallback.
 *
 * `isAppListingsEnabled` DECOUPLES store visibility from `app-blocks-enabled`
 * (the block-runtime kill-switch): it evaluates the dedicated `app-listings`
 * flag and, ONLY if that resolves false, FALLS BACK to `isAppBlocksEnabled`.
 * That fallback is load-bearing — `app-listings` does not exist at merge time,
 * so the fallback keeps the current mods+testers cohort in (zero behavior change
 * today). A future true-public flip widens ONLY `app-listings`.
 *
 * The fake models BOTH flags: `app-blocks-enabled` = mod segment; `app-listings`
 * = a configurable per-user grant set (empty = the dark window / flag absent).
 */
describe('isAppListingsEnabled — dedicated visibility flag + OR-fallback (W13)', () => {
  let appListingsGrants: Set<string>;

  function fakeVisibilityFlags(
    flag: string,
    entityId = 'global',
    context: Record<string, string> = {}
  ): boolean {
    if (flag === 'app-blocks-enabled') return context.isModerator === 'true';
    if (flag === 'app-listings') {
      // Per-user segment grant. No-user / global eval never matches (dark window).
      return typeof context.userId === 'string' && appListingsGrants.has(context.userId);
    }
    return false;
  }

  beforeEach(() => {
    appListingsGrants = new Set();
    mockIsFlipt.mockReset();
    mockIsFlipt.mockImplementation(async (...args: Parameters<typeof fakeVisibilityFlags>) =>
      fakeVisibilityFlags(...args)
    );
  });

  it('app-listings granted for the user → true (dedicated flag lit, no fallback needed)', async () => {
    appListingsGrants.add('888');
    const user = makeUser({ id: 888, isModerator: false });
    await expect(isAppListingsEnabled({ user })).resolves.toBe(true);
    // Evaluated the dedicated visibility flag WITH the user's context...
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-listings',
      '888',
      expect.objectContaining({ userId: '888' })
    );
    // ...and short-circuited: the fallback flag was never consulted.
    expect(mockIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
  });

  it('app-listings false + app-blocks-enabled true (mod) → true via the OR-fallback', async () => {
    // The dark-window case: `app-listings` grants nobody yet, but a mod still has
    // store access through the `app-blocks-enabled` fallback.
    const user = makeUser({ id: 123, isModerator: true });
    await expect(isAppListingsEnabled({ user })).resolves.toBe(true);
    // Read app-listings FIRST, then fell back to app-blocks-enabled.
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-listings',
      '123',
      expect.objectContaining({ userId: '123' })
    );
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-blocks-enabled',
      '123',
      expect.objectContaining({ isModerator: 'true' })
    );
  });

  it('both flags false (non-mod, no listings grant) → false', async () => {
    const user = makeUser({ id: 555, isModerator: false });
    await expect(isAppListingsEnabled({ user })).resolves.toBe(false);
    // Fell through both the dedicated flag AND the fallback.
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-listings',
      '555',
      expect.objectContaining({ userId: '555' })
    );
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-blocks-enabled',
      '555',
      expect.objectContaining({ isModerator: 'false' })
    );
  });

  it('no user → global eval of BOTH flags, fail-closed false', async () => {
    await expect(isAppListingsEnabled({ user: undefined })).resolves.toBe(false);
    await expect(isAppListingsEnabled()).resolves.toBe(false);
    // Both the dedicated flag and the fallback are evaluated globally (no context).
    expect(mockIsFlipt).toHaveBeenCalledWith('app-listings');
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-enabled');
  });

  it('reads ONLY app-listings + app-blocks-enabled (never the pipeline / runtime keys)', async () => {
    const user = makeUser({ id: 555, isModerator: false });
    await isAppListingsEnabled({ user });
    for (const call of mockIsFlipt.mock.calls) {
      expect(['app-listings', 'app-blocks-enabled']).toContain(call[0]);
    }
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-pipeline-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-runtime-enabled');
    expect(mockIsFlipt).not.toHaveBeenCalledWith('app-blocks-author');
  });
});
