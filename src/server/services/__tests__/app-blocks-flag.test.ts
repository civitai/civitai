import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from 'next-auth';

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

import { isAppBlocksEnabled } from '../app-blocks-flag';

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
