import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * FORKABLE APPS rollout gate — `isAppBlocksForkEnabled`.
 *
 * Fail-closed for EVERYONE (no moderator floor): an absent flag, an unreachable Flipt and a
 * throwing client all read `false`; a moderator is admitted only by the flag's own segment; an
 * anonymous caller is refused without a flag eval at all (a no-user eval would return the flag's
 * BASE value — see GLOBAL-EVAL SEMANTICS in `app-blocks-flag.ts`).
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: mockIsFlipt }));

import { APP_BLOCKS_FORK_FLAG, isAppBlocksForkEnabled } from '../app-blocks-flag';

// Faithful stand-in for the rollout's first stage: base OFF with a `moderators` segment keyed on
// context.isModerator === 'true'. `flagExists=false` is the as-merged (absent) state.
const state = { flagExists: true };
function fakeFlag(flag: string, _entityId = 'global', context: Record<string, string> = {}) {
  if (!state.flagExists) return false;
  if (flag !== APP_BLOCKS_FORK_FLAG) return false;
  return context.isModerator === 'true';
}

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return { id: 5150, username: 'u', isModerator: false, tier: 'free', ...over } as SessionUser;
}

beforeEach(() => {
  state.flagExists = true;
  mockIsFlipt.mockReset();
  mockIsFlipt.mockImplementation(async (...args: Parameters<typeof fakeFlag>) => fakeFlag(...args));
});

describe('isAppBlocksForkEnabled', () => {
  // The literal key below is the wire contract with the flag definition outside this repo.
  it('a moderator is ON when the flag exists, evaluated with their own context', async () => {
    await expect(isAppBlocksForkEnabled({ user: makeUser({ isModerator: true }) })).resolves.toBe(
      true
    );
    expect(mockIsFlipt).toHaveBeenCalledWith(
      'app-blocks-fork',
      '5150',
      expect.objectContaining({ isModerator: 'true' })
    );
  });

  it('a non-moderator outside the segment is OFF', async () => {
    await expect(isAppBlocksForkEnabled({ user: makeUser() })).resolves.toBe(false);
  });

  it('an ABSENT flag is OFF — moderators included (no static floor)', async () => {
    state.flagExists = false;
    await expect(isAppBlocksForkEnabled({ user: makeUser({ isModerator: true }) })).resolves.toBe(
      false
    );
  });

  it('Flipt DOWN (the eval rejects) is OFF, not an error', async () => {
    mockIsFlipt.mockRejectedValue(new Error('flipt unreachable'));
    await expect(isAppBlocksForkEnabled({ user: makeUser({ isModerator: true }) })).resolves.toBe(
      false
    );
  });

  it('no user is OFF without evaluating the flag at all', async () => {
    await expect(isAppBlocksForkEnabled({ user: undefined })).resolves.toBe(false);
    await expect(isAppBlocksForkEnabled({ user: null })).resolves.toBe(false);
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });
});
