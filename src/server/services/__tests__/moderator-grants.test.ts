import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `hasModeratorGrant` holds the main app to the moderator app's permission semantics
 * (`resolvePermissions` in `apps/moderator/src/lib/server/access.ts`): `moderator:admin` always, anyone
 * else only through a role on the `grant:<id>` row, and no row means nobody.
 */
const { row, where } = vi.hoisted(() => ({
  row: { value: undefined as { roles: string[] } | undefined },
  where: vi.fn(),
}));
vi.mock('~/server/db/kyselyDb', () => {
  const query = {
    select: () => query,
    where: (...a: unknown[]) => {
      where(...a);
      return query;
    },
    executeTakeFirst: async () => row.value,
  };
  return { kyselyWrite: { selectFrom: () => query } };
});

import { hasModeratorGrant } from '~/server/services/moderator-grants';

beforeEach(() => {
  vi.clearAllMocks();
  row.value = undefined;
});

describe('hasModeratorGrant', () => {
  it('allows moderator:admin with no grant row at all', async () => {
    expect(await hasModeratorGrant({ roles: ['moderator:admin'] }, 'user.deleteAccount')).toBe(
      true
    );
  });

  it('allows a role listed on the grant row, reading the row for that permission', async () => {
    row.value = { roles: ['moderator:gdpr'] };
    expect(
      await hasModeratorGrant(
        { roles: ['moderator:triage', 'moderator:gdpr'] },
        'user.deleteAccount'
      )
    ).toBe(true);
    expect(where).toHaveBeenCalledWith('app', '=', 'moderator');
    expect(where).toHaveBeenCalledWith('path', '=', 'grant:user.deleteAccount');
  });

  it('refuses a role that is not on the grant row', async () => {
    row.value = { roles: ['moderator:gdpr'] };
    expect(await hasModeratorGrant({ roles: ['moderator:triage'] }, 'user.deleteAccount')).toBe(
      false
    );
  });

  it('refuses everyone but admin when no grant row exists', async () => {
    expect(await hasModeratorGrant({ roles: ['moderator:triage'] }, 'user.deleteAccount')).toBe(
      false
    );
  });

  it('refuses a user with no roles', async () => {
    row.value = { roles: ['moderator:gdpr'] };
    expect(await hasModeratorGrant({}, 'user.deleteAccount')).toBe(false);
  });
});
