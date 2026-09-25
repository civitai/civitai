import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 🔴 NAMED FOR A DECISION. `user.delete` on the tRPC side deletes YOUR OWN account, in every
 * environment, and a moderator deleting somebody else's goes through `/api/mod/user/delete`.
 *
 * Between 2023-12-20 and this change the handler carried `!isProd && currentUser.isModerator`,
 * which let a moderator delete anyone on a non-production build. It read as a safety measure and
 * was the opposite of one — it never existed in production, it granted rather than withheld, and
 * the deletions it allowed left no ModActivity row. Restoring it would recreate a second
 * definition of moderator deletion, live only where it is never exercised against real data, and
 * silently route around the audit row the moderator endpoint writes.
 *
 * If you are here because a dev workflow wants the shortcut back: use the endpoint. It works on a
 * dev server against the dev database, and it records who acted.
 */

const { deleteUser, trackUserActivity } = vi.hoisted(() => ({
  deleteUser: vi.fn(async () => ({ id: 1 })),
  trackUserActivity: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteUser: (...a: unknown[]) => deleteUser(...(a as [])),
}));

import { deleteUserHandler } from '~/server/controllers/user.controller';

type Ctx = Parameters<typeof deleteUserHandler>[0]['ctx'];

function ctxFor(user: { id: number; isModerator: boolean }) {
  return {
    user,
    track: { userActivity: trackUserActivity },
  } as unknown as Ctx;
}

const SELF = 990000101;
const SOMEBODY_ELSE = 990000202;

beforeEach(() => vi.clearAllMocks());

describe('user.delete (tRPC) is self-only, in every environment', () => {
  it('refuses a MODERATOR deleting somebody else', async () => {
    await expect(
      deleteUserHandler({
        ctx: ctxFor({ id: SELF, isModerator: true }),
        input: { id: SOMEBODY_ELSE },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('refuses an ordinary user deleting somebody else', async () => {
    await expect(
      deleteUserHandler({
        ctx: ctxFor({ id: SELF, isModerator: false }),
        input: { id: SOMEBODY_ELSE },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(deleteUser).not.toHaveBeenCalled();
  });

  // THE CONTROL for the ordinary-user refusal: without it, that refusal passes against a handler
  // that refuses non-moderators outright.
  it('allows anyone to delete their OWN account', async () => {
    await deleteUserHandler({
      ctx: ctxFor({ id: SELF, isModerator: false }),
      input: { id: SELF },
    });

    expect(deleteUser).toHaveBeenCalledWith({ id: SELF });
  });

  // THE CONTROL for the moderator refusal above: without it, that refusal passes against a handler
  // that refuses moderators outright.
  it('still lets a moderator delete their OWN account', async () => {
    await deleteUserHandler({
      ctx: ctxFor({ id: SELF, isModerator: true }),
      input: { id: SELF },
    });

    expect(deleteUser).toHaveBeenCalledWith({ id: SELF });
  });
});
