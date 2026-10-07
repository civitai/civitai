import { describe, expect, it } from 'vitest';
import { constants } from '~/server/common/constants';
import { resolveActorFor } from '~/utils/resolve-attribution';

describe('resolveActorFor', () => {
  it('classifies no session as anon', () => {
    expect(resolveActorFor(undefined)).toBe('anon');
    expect(resolveActorFor(null)).toBe('anon');
    expect(resolveActorFor({})).toBe('anon');
  });

  // Internal services authenticate as the system account. Pinned as the literal
  // -1 as well as the constant, so the test cannot follow the constant if it moves.
  it('classifies the system account as internal', () => {
    expect(constants.system.user.id).toBe(-1);
    expect(resolveActorFor({ id: -1 })).toBe('internal');
  });

  it('classifies any other signed-in user as user', () => {
    expect(resolveActorFor({ id: 42 })).toBe('user');
    // Ids next to the system id, so a range check (`id <= 0`) or a truthiness
    // check (`!user?.id`) in place of the exact comparison is caught.
    expect(resolveActorFor({ id: 1 })).toBe('user');
    expect(resolveActorFor({ id: 0 })).toBe('user');
  });
});
