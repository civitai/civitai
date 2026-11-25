import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Revocation from '~/server/services/user-token-revocation.service';

// A ban disables the account's OAuth apps and takes away its app access; an unban restores
// neither. Both legs are covered on their own (ban-access-cleanup.service.test.ts,
// app-access-request.service.test.ts); this pins that every ban reaches them and an unban does not.

const { disableOauthForBannedUser, revokeAppAccessForBannedUser } = vi.hoisted(() => ({
  disableOauthForBannedUser: vi.fn(async (_userId: number) => ({
    disabled: [] as string[],
    flagged: [] as string[],
    consents: 0,
    flagDelivery: null,
  })),
  revokeAppAccessForBannedUser: vi.fn(async (_args: { userId: number; actorId: number }) => 0),
}));
vi.mock('~/server/services/ban-access-cleanup.service', () => ({
  disableOauthForBannedUser,
  revokeAppAccessForBannedUser,
}));
vi.mock('~/server/services/user-token-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Revocation>()),
  revokeUserTokens: vi.fn(async () => true),
}));

const { toggleBan } = await import('~/server/services/user.service');

const USER = 4242;
const MODERATOR = 17;
const account = (bannedAt: Date | null) => ({
  id: USER,
  bannedAt,
  meta: {},
  username: 'someone',
  email: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of ['userLink', 'model', 'post', 'article'] as const) {
    dbMock.dbWrite[model].deleteMany?.mockResolvedValue({ count: 0 } as never);
    dbMock.dbWrite[model].updateMany?.mockResolvedValue({ count: 0 } as never);
  }
  dbMock.dbWrite.user.update.mockResolvedValue(account(new Date()) as never);
});

describe('a ban disables OAuth apps and app access', () => {
  it('🔴 a moderator ban reaches both legs, for the banned user, attributed to the moderator', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(null) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(null) as never);
    await toggleBan({ id: USER, userId: MODERATOR, isModerator: true } as never);
    expect(disableOauthForBannedUser.mock.calls).toEqual([[USER]]);
    expect(revokeAppAccessForBannedUser.mock.calls).toEqual([
      [{ userId: USER, actorId: MODERATOR }],
    ]);
  });

  it('a failing leg does not fail the ban', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(null) as never);
    disableOauthForBannedUser.mockRejectedValueOnce(new Error('db down'));
    revokeAppAccessForBannedUser.mockRejectedValueOnce(new Error('db down'));
    await expect(
      toggleBan({ id: USER, userId: MODERATOR, isModerator: true } as never)
    ).resolves.toBeDefined();
  });

  it('🔴 an unban reaches neither: nothing is re-enabled or re-granted', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(account(new Date()) as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(account(new Date()) as never);
    await toggleBan({ id: USER, userId: MODERATOR, isModerator: true } as never);
    expect(disableOauthForBannedUser).not.toHaveBeenCalled();
    expect(revokeAppAccessForBannedUser).not.toHaveBeenCalled();
  });
});
