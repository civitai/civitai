import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as Cloudflare from '~/server/cloudflare/client';
import type * as SearchIndex from '~/server/search-index';
import type * as UserProfileService from '~/server/services/user-profile.service';
import type * as UserService from '~/server/services/user.service';
import type * as UtilService from '~/server/services/util.service';

/**
 * The creator-card bust in the three write handlers that were covered only by a call-site ledger:
 * `updateUserProfileHandler`, `addEntityToShowcaseHandler` and `updateUserHandler`. Each test warms
 * the card, changes the user underneath it, runs the handler on its ordinary path and reads the card
 * back. `refreshSession` is the global no-op stub here (src/__tests__/setup.ts), so the handler's own
 * `bustUserCreator` is the only thing that can drop the entry.
 */

const { purgeCache, mocks } = vi.hoisted(() => ({
  purgeCache: vi.fn(),
  mocks: {
    updateUserProfile: vi.fn(),
    getUserWithProfile: vi.fn(),
    getUserById: vi.fn(),
    updateUserById: vi.fn(),
  },
}));
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Cloudflare>()),
  purgeCache,
}));
vi.mock('~/server/services/user-profile.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfileService>()),
  updateUserProfile: mocks.updateUserProfile,
  getUserWithProfile: mocks.getUserWithProfile,
}));
vi.mock('~/server/services/util.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UtilService>()),
  entityExists: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserById: mocks.getUserById,
  updateUserById: mocks.updateUserById,
  isUsernamePermitted: vi.fn(async () => true),
  updateLeaderboardRankForUsers: vi.fn(async () => undefined),
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));

const { getUserCreator } = await import('~/server/services/user.service');
const { updateUserProfileHandler, addEntityToShowcaseHandler } = await import(
  '~/server/controllers/user-profile.controller'
);
const { updateUserHandler } = await import('~/server/controllers/user.controller');

const OWNER = 6101;
const MODERATOR = 6102;
let usernames: Record<number, string>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
  installFakeCacheRedis();
  usernames = { [OWNER]: 'owner-before', [MODERATOR]: 'mod-before' };
  purgeCache.mockResolvedValue(undefined);
  dbMock.dbRead.user.findFirst.mockImplementation((async ({ where }: { where: { id: number } }) =>
    usernames[where.id]
      ? {
          id: where.id,
          username: usernames[where.id],
          settings: null,
          cosmetics: [],
          links: [],
        }
      : null) as never);
  dbMock.dbRead.model.count.mockResolvedValue(0 as never);
  // The username the edge purge reads from the primary, after the write.
  dbMock.dbWrite.user.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ username: usernames[id] }))) as never);
  mocks.updateUserProfile.mockResolvedValue({ id: OWNER });
  mocks.getUserWithProfile.mockResolvedValue({ id: OWNER, profile: { showcaseItems: [] } });
  mocks.getUserById.mockResolvedValue({
    username: 'owner-before',
    profilePictureId: null,
    profilePicture: null,
  });
  mocks.updateUserById.mockResolvedValue({ id: OWNER, profilePictureId: null });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Warm both cards, rename both users underneath them, run the write, return what each card says. */
async function cardsAfter(write: () => Promise<unknown>) {
  await getUserCreator({ id: OWNER });
  await getUserCreator({ id: MODERATOR });
  usernames = { [OWNER]: 'owner-after', [MODERATOR]: 'mod-after' };
  await write();
  return {
    owner: (await getUserCreator({ id: OWNER }))?.username,
    moderator: (await getUserCreator({ id: MODERATOR }))?.username,
  };
}

describe('creator-card bust in the profile and user write handlers', () => {
  it('control: with no write, both cached cards are served', async () => {
    expect(await cardsAfter(async () => undefined)).toEqual({
      owner: 'owner-before',
      moderator: 'mod-before',
    });
  });

  it('updateUserProfileHandler busts the EDITED user, not the moderator editing them', async () => {
    const cards = await cardsAfter(() =>
      updateUserProfileHandler({
        input: { userId: OWNER, bio: 'hello' },
        ctx: { user: { id: MODERATOR, isModerator: true, muted: false } },
      } as never)
    );
    expect(cards).toEqual({ owner: 'owner-after', moderator: 'mod-before' });
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [`user-creator-${OWNER}`, 'user-creator-owner-after'],
    });
  });

  it('addEntityToShowcaseHandler busts the caller', async () => {
    const cards = await cardsAfter(() =>
      addEntityToShowcaseHandler({
        input: { entityType: 'Model', entityId: 77 },
        ctx: { user: { id: OWNER, isModerator: false } },
      } as never)
    );
    expect(cards).toEqual({ owner: 'owner-after', moderator: 'mod-before' });
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [`user-creator-${OWNER}`, 'user-creator-owner-after'],
    });
  });

  it('updateUserHandler busts the caller by id, new username and old username', async () => {
    const cards = await cardsAfter(() =>
      updateUserHandler({
        input: { id: OWNER, username: 'owner-after' },
        ctx: { user: { id: OWNER } },
      } as never)
    );
    expect(cards).toEqual({ owner: 'owner-after', moderator: 'mod-before' });
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [`user-creator-${OWNER}`, 'user-creator-owner-after', 'user-creator-owner-before'],
    });
  });
});
