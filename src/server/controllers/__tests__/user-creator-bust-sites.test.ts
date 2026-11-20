import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as Cloudflare from '~/server/cloudflare/client';
import type * as SearchIndex from '~/server/search-index';
import type * as UserProfileService from '~/server/services/user-profile.service';
import type * as UserService from '~/server/services/user.service';
import type * as UserCreatorReads from '~/server/services/user-creator.reads';
import type * as UtilService from '~/server/services/util.service';

/**
 * The creator-card bust in the three write handlers that were covered only by a call-site ledger:
 * `updateUserProfileHandler`, `addEntityToShowcaseHandler` and `updateUserHandler`. Each test warms
 * the card, changes the user underneath it, runs the handler on its ordinary path and reads the card
 * back. `refreshSession` is the global no-op stub here (src/__tests__/setup.ts), so the handler's own
 * `bustUserCreator` is the only thing that can drop the entry.
 */

// The CSAM bucket upload a moderator's edit of a reported user waits on.
const upload = vi.hoisted(() => ({
  fail: undefined as Error | undefined,
  done: [] as string[],
  bodies: [] as string[],
}));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {
    private readonly params: { Body: NodeJS.ReadableStream; Key: string };
    constructor({ params }: { params: { Body: NodeJS.ReadableStream; Key: string } }) {
      this.params = params;
    }
    async done() {
      const chunks: Buffer[] = [];
      for await (const chunk of this.params.Body)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      if (upload.fail) throw upload.fail;
      upload.done.push(this.params.Key);
      upload.bodies.push(Buffer.concat(chunks).toString('utf8'));
      return { ETag: '"etag"' };
    }
  };
  return { Upload, default: { Upload } };
});

const { purgeCache, readCreator, mocks } = vi.hoisted(() => ({
  purgeCache: vi.fn(),
  readCreator: vi.fn(),
  mocks: {
    updateUserProfile: vi.fn(),
    getUserWithProfile: vi.fn(),
    getUserById: vi.fn(),
    updateUserById: vi.fn(),
  },
}));
// The creator card's database read (the user and its published-model count, one Kysely read).
vi.mock('~/server/services/user-creator.reads', async (importOriginal) => ({
  ...(await importOriginal<typeof UserCreatorReads>()),
  readUserCreatorViaKysely: readCreator,
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
  readCreator.mockImplementation(async (_db: unknown, where: { id: number }) =>
    usernames[where.id]
      ? {
          user: {
            id: where.id,
            username: usernames[where.id],
            settings: null,
            cosmetics: [],
            links: [],
          },
          modelCount: 0,
        }
      : null
  );
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

  describe("a moderator editing another user's profile", () => {
    const edit = (ctxUser: { id: number; isModerator: boolean }) =>
      updateUserProfileHandler({
        input: { userId: OWNER, bio: '' },
        ctx: { user: { ...ctxUser, muted: false } },
      } as never);

    it('records the edit, and archives nothing for a user no report names', async () => {
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValue(null as never);
      await edit({ id: MODERATOR, isModerator: true });
      expect(dbMock.dbWrite.csamReport.findFirst).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.userProfile.findUnique).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modActivity.create).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.modActivity.create).toHaveBeenCalledWith({
        data: { userId: MODERATOR, activity: 'editProfile', entityType: 'User', entityId: OWNER },
      });
    });

    it('returns the committed edit when its record fails to write', async () => {
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValue(null as never);
      dbMock.dbWrite.modActivity.create.mockRejectedValueOnce(new Error('db blip'));
      await expect(edit({ id: MODERATOR, isModerator: true })).resolves.not.toThrow();
      expect(mocks.updateUserProfile).toHaveBeenCalledTimes(1);
    });

    describe('of a user a report names', () => {
      const stored = {
        bio: 'b',
        message: null,
        messageAddedAt: null,
        sfwBio: null,
        sfwMessage: null,
        location: null,
        showcaseSections: [],
      };
      beforeEach(() => {
        setEnv({
          CSAM_UPLOAD_KEY: 'test-key',
          CSAM_UPLOAD_SECRET: 'test-secret',
          CSAM_UPLOAD_REGION: 'test-region',
          CSAM_UPLOAD_ENDPOINT: 'https://example.invalid',
          CSAM_BUCKET_NAME: 'test-bucket',
        });
        upload.fail = undefined;
        upload.done = [];
        upload.bodies = [];
        dbMock.dbWrite.userLink.findMany.mockResolvedValue([] as never);
        dbMock.dbWrite.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
        dbMock.dbWrite.userProfile.findUnique.mockResolvedValue(stored as never);
      });

      it('archives the profile before the edit lands', async () => {
        mocks.updateUserProfile.mockImplementationOnce(async () => {
          expect(upload.done.some((k) => k.endsWith('_profile.json'))).toBe(true);
          return {} as never;
        });
        await edit({ id: MODERATOR, isModerator: true });
        expect(mocks.updateUserProfile).toHaveBeenCalledTimes(1);
      });

      it('refuses the edit when the archive fails', async () => {
        upload.fail = new Error('s3 down');
        await expect(edit({ id: MODERATOR, isModerator: true })).rejects.toThrow();
        expect(mocks.updateUserProfile).not.toHaveBeenCalled();
        expect(dbMock.dbWrite.modActivity.create).not.toHaveBeenCalled();
      });

      it('archives before an edit of only the civitai.com copies', async () => {
        await updateUserProfileHandler({
          input: { userId: OWNER, sfwBio: '' },
          ctx: { user: { id: MODERATOR, isModerator: true, muted: false } },
        } as never);
        expect(upload.done.some((k) => k.endsWith('_profile.json'))).toBe(true);
      });

      it.each(['message', 'sfwMessage', 'location'])(
        'archives before an edit of %s',
        async (key) => {
          await updateUserProfileHandler({
            input: { userId: OWNER, [key]: '' },
            ctx: { user: { id: MODERATOR, isModerator: true, muted: false } },
          } as never);
          expect(upload.done.some((k) => k.endsWith('_profile.json'))).toBe(true);
        }
      );

      it.each(['socialLinks', 'sponsorshipLinks'])(
        'archives the old links before a moderator replaces %s',
        async (key) => {
          dbMock.dbWrite.userLink.findMany.mockResolvedValue([
            { id: 5, url: 'https://example.invalid/old', type: 'Social' },
          ] as never);
          await updateUserProfileHandler({
            input: { userId: OWNER, [key]: [] },
            ctx: { user: { id: MODERATOR, isModerator: true, muted: false } },
          } as never);
          const archived = JSON.parse(upload.bodies[0]);
          expect(archived.links).toEqual([
            { id: 5, url: 'https://example.invalid/old', type: 'Social' },
          ]);
          expect(archived.clearedFields).toEqual(['links']);
        }
      );

      it('archives nothing for an edit that touches no profile text', async () => {
        await updateUserProfileHandler({
          input: { userId: OWNER, coverImageId: null },
          ctx: { user: { id: MODERATOR, isModerator: true, muted: false } },
        } as never);
        expect(dbMock.dbWrite.csamReport.findFirst).not.toHaveBeenCalled();
        expect(upload.done).toEqual([]);
      });
    });

    it('leaves an owner editing their own profile alone', async () => {
      await edit({ id: OWNER, isModerator: false });
      expect(dbMock.dbWrite.csamReport.findFirst).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modActivity.create).not.toHaveBeenCalled();
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
