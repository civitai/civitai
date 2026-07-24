import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — flag-gate contract for
 * `isAppBlocksAgenticReviewEnabled`. Mirrors the review-sandbox gate:
 *   - a MODERATOR resolves ON only when the flag exists + its moderators segment
 *     matches (threads the mod context in);
 *   - a NON-MODERATOR and an ANONYMOUS caller resolve OFF (no widening);
 *   - an ABSENT flag resolves OFF for everyone (fail-closed — the as-merged
 *     state, since the flag does not exist in Flipt yet).
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: mockIsFlipt }));

import {
  isAppBlocksAgenticReviewEnabled,
  APP_BLOCKS_AGENTIC_REVIEW_FLAG,
} from '../app-blocks-flag';

// Faithful stand-in for the live flag rule: base OFF with a `moderators` segment
// keyed on context.isModerator === 'true'. `flagExists` toggles the as-merged
// (absent) state — an absent flag never evaluates true.
const state = { flagExists: true };
function fakeFlag(
  flag: string,
  _entityId = 'global',
  context: Record<string, string> = {}
): boolean {
  if (!state.flagExists) return false;
  if (flag !== APP_BLOCKS_AGENTIC_REVIEW_FLAG) return false;
  return context.isModerator === 'true';
}

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return { id: 4242, username: 'u', isModerator: false, tier: 'free', ...over } as SessionUser;
}

beforeEach(() => {
  state.flagExists = true;
  mockIsFlipt.mockReset();
  mockIsFlipt.mockImplementation(async (...args: Parameters<typeof fakeFlag>) => fakeFlag(...args));
});

describe('isAppBlocksAgenticReviewEnabled — fail-closed mod gate', () => {
  it('resolves ON for a moderator when the flag exists (threads mod context)', async () => {
    const user = makeUser({ isModerator: true });
    await expect(isAppBlocksAgenticReviewEnabled({ user })).resolves.toBe(true);
    expect(mockIsFlipt).toHaveBeenCalledWith(
      APP_BLOCKS_AGENTIC_REVIEW_FLAG,
      '4242',
      expect.objectContaining({ isModerator: 'true' })
    );
  });

  it('resolves OFF for a non-moderator user (no widening)', async () => {
    await expect(isAppBlocksAgenticReviewEnabled({ user: makeUser() })).resolves.toBe(false);
  });

  it('resolves OFF for an anonymous caller (no user → global eval)', async () => {
    await expect(isAppBlocksAgenticReviewEnabled()).resolves.toBe(false);
    // The no-user path must NOT thread any context (a global eval that can never
    // match the moderators segment).
    expect(mockIsFlipt).toHaveBeenCalledWith(APP_BLOCKS_AGENTIC_REVIEW_FLAG);
  });

  it('resolves OFF for a moderator when the flag is ABSENT (as-merged dark state)', async () => {
    state.flagExists = false;
    await expect(
      isAppBlocksAgenticReviewEnabled({ user: makeUser({ isModerator: true }) })
    ).resolves.toBe(false);
  });
});
