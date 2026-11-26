import { describe, expect, it } from 'vitest';
import { assertMemorialModerator } from '~/server/services/memorial-moderator';

const ctx = { actor: { roles: ['moderator:admin'] }, req: {}, res: {} } as never;
const withSession = (impersonatedBy: number | null) => ({
  getSession: async () => ({ impersonatedBy } as never),
  hasGrant: async () => true,
});

describe('assertMemorialModerator', () => {
  it("refuses a moderator's impersonation session at the route", async () => {
    await expect(assertMemorialModerator(ctx, withSession(7))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets the same moderator through on their own session', async () => {
    await expect(assertMemorialModerator(ctx, withSession(null))).resolves.toBeUndefined();
  });
});
