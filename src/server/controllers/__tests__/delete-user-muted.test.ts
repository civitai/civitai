import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SUPPORT_LINKS } from '~/components/Support/support.constants';

/**
 * A muted account cannot close itself through `user.delete`: deletion scrubs the email and the
 * OAuth links, so the same person could sign up again clean. Erasure stays available through a
 * support ticket, which a moderator carries out via `/api/mod/user/delete` (its own case lives in
 * `src/__tests__/pages/api/mod/user/delete.test.ts`).
 *
 * `deleteUser` is faked over an in-memory row so "nothing was deleted" is read off the row itself.
 */

type Row = { id: number; muted: boolean; email: string | null; accounts: string[] };

const { store, deleteUser, trackUserActivity } = vi.hoisted(() => {
  const store = new Map<number, Row>();
  return {
    store,
    // Mirrors what the real service scrubs: the email and every linked sign-in account.
    deleteUser: vi.fn(async ({ id }: { id: number }) => {
      const row = store.get(id);
      if (!row) return null;
      row.email = null;
      row.accounts = [];
      return { id };
    }),
    trackUserActivity: vi.fn(async () => undefined),
  };
});

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteUser: (...a: unknown[]) => deleteUser(...(a as [{ id: number }])),
}));

import {
  deleteUserHandler,
  SELF_DELETE_RESTRICTED_MESSAGE,
} from '~/server/controllers/user.controller';
import { LegalHoldError } from '~/server/services/legal-hold.service';

type Ctx = Parameters<typeof deleteUserHandler>[0]['ctx'];

const SELF = 990000303;

// The session deliberately says NOT muted: the handler must read the primary, so a mute that
// landed after the session was issued still blocks.
const ctx = {
  user: { id: SELF, isModerator: false, muted: false },
  track: { userActivity: trackUserActivity },
} as unknown as Ctx;

function seed(muted: boolean) {
  const row: Row = { id: SELF, muted, email: 'person@example.com', accounts: ['discord'] };
  store.set(SELF, row);
  dbMock.dbWrite.user.findUnique.mockImplementation((async (args: { where: { id: number } }) => {
    const r = store.get(args.where.id);
    return r ? { muted: r.muted } : null;
  }) as never);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe('user.delete (tRPC) refuses a muted account', () => {
  it('refuses, points to support, and leaves the account intact', async () => {
    const row = seed(true);
    const before = structuredClone(row);

    await expect(deleteUserHandler({ ctx, input: { id: SELF } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining(SUPPORT_LINKS.portal),
    });

    expect(store.get(SELF)).toEqual(before);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(trackUserActivity).not.toHaveBeenCalled();
    // The mute was read from the primary for this user, not from the session.
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SELF } })
    );
  });

  // THE CONTROL: the same call for an unmuted account deletes, so the refusal above is the mute
  // and not a handler that refuses everyone.
  it('still deletes an account that is not muted', async () => {
    const row = seed(false);

    await deleteUserHandler({ ctx, input: { id: SELF } });

    expect(deleteUser).toHaveBeenCalledWith({ id: SELF });
    expect(row.email).toBeNull();
    expect(row.accounts).toEqual([]);
    expect(trackUserActivity).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: SELF, type: 'Account closure' })
    );
  });
});

describe('user.delete (tRPC) refuses an account under a legal hold', () => {
  it('with exactly the refusal a muted account gets, so the two cannot be told apart', async () => {
    seed(true);
    const muted = await deleteUserHandler({ ctx, input: { id: SELF } }).catch((e) => e);

    seed(false);
    deleteUser.mockRejectedValueOnce(new LegalHoldError());
    const held = await deleteUserHandler({ ctx, input: { id: SELF } }).catch((e) => e);

    expect(held).toMatchObject({ code: 'FORBIDDEN' });
    expect(held.message).toBe(muted.message);
    expect(held.message).toBe(SELF_DELETE_RESTRICTED_MESSAGE);
    expect(trackUserActivity).not.toHaveBeenCalled();
  });
});
