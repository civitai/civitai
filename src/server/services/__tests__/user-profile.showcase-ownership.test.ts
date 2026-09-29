import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CloudflareClient from '~/server/cloudflare/client';

vi.mock('~/server/services/image.service', () => ({
  enqueueImageIngestion: vi.fn(async () => undefined),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/redis/caches', () => ({
  getUserContentOverview: vi.fn(async () => ({})),
  getUserContentOverviewPublic: vi.fn(async () => ({})),
  getUserContentOverviewSfw: vi.fn(async () => ({})),
}));
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof CloudflareClient>()),
  purgeCache: vi.fn(async () => undefined),
}));

import {
  assertShowcaseItemsOwned,
  updateUserProfile,
} from '~/server/services/user-profile.service';
import { addEntityToShowcaseHandler } from '~/server/controllers/user-profile.controller';
import type { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';

const OWNER_ID = 100;
const STRANGER_ID = 200;
const OWN_IMAGE = 1;
const OWN_MODEL = 2;
const STRANGER_IMAGE = 3;
const TRANSFERRED_MODEL = 4;

const db = dbMock.dbWrite;

// Mirrors the `where: { id: { in }, userId }` filter: only rows belonging to the queried user return.
const ownedBy: Record<'image' | 'model', Record<number, number>> = {
  image: { [OWN_IMAGE]: OWNER_ID, [STRANGER_IMAGE]: STRANGER_ID },
  model: { [OWN_MODEL]: OWNER_ID, [TRANSFERRED_MODEL]: STRANGER_ID },
};
const findOwned =
  (table: 'image' | 'model') =>
  async ({ where }: { where: { id: { in: number[] }; userId: number } }) =>
    where.id.in.filter((id) => ownedBy[table][id] === where.userId).map((id) => ({ id }));

const tx = {
  userLink: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  userProfile: {
    update: vi.fn(async () => ({ userId: OWNER_ID, coverImage: null, sfwCoverImage: null })),
  },
};

const storeShowcase = (showcaseItems: ShowcaseItemSchema[]) =>
  db.user.findUniqueOrThrow.mockResolvedValue({
    id: OWNER_ID,
    meta: {},
    settings: {},
    publicSettings: {},
    profile: { userId: OWNER_ID, message: null, coverImage: null, showcaseItems },
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.image.findMany.mockImplementation(findOwned('image') as never);
  db.model.findMany.mockImplementation(findOwned('model') as never);
  db.image.findUniqueOrThrow.mockResolvedValue({ id: STRANGER_IMAGE } as never);
  dbMock.dbRead.image.findUniqueOrThrow.mockResolvedValue({ id: STRANGER_IMAGE } as never);
  db.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));
  dbMock.dbRead.userStat.findFirst.mockResolvedValue(null);
  storeShowcase([]);
});

describe('assertShowcaseItemsOwned', () => {
  it("rejects another user's image", async () => {
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        showcaseItems: [{ entityType: 'Image', entityId: STRANGER_IMAGE }],
        currentShowcaseItems: [],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a model the caller does not own, even alongside owned items', async () => {
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        showcaseItems: [
          { entityType: 'Image', entityId: OWN_IMAGE },
          { entityType: 'Model', entityId: 999 },
        ],
        currentShowcaseItems: [],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts own images and models, including a duplicated id', async () => {
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        showcaseItems: [
          { entityType: 'Image', entityId: OWN_IMAGE },
          { entityType: 'Image', entityId: OWN_IMAGE },
          { entityType: 'Model', entityId: OWN_MODEL },
        ],
        currentShowcaseItems: [],
      })
    ).resolves.toBeUndefined();
  });

  it('rejects entity types the showcase does not support, for moderators too', async () => {
    for (const isModerator of [false, true])
      await expect(
        assertShowcaseItemsOwned({
          userId: OWNER_ID,
          isModerator,
          showcaseItems: [{ entityType: 'Article', entityId: 5 }],
          currentShowcaseItems: [],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does not re-check items already on the stored showcase', async () => {
    const stored = { entityType: 'Model' as const, entityId: TRANSFERRED_MODEL };
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        showcaseItems: [stored, { entityType: 'Image', entityId: OWN_IMAGE }],
        currentShowcaseItems: [stored],
      })
    ).resolves.toBeUndefined();
    expect(db.model.findMany).not.toHaveBeenCalled();
  });

  it('does not treat a stored item of another type with the same id as already present', async () => {
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        showcaseItems: [{ entityType: 'Image', entityId: STRANGER_IMAGE }],
        currentShowcaseItems: [{ entityType: 'Model', entityId: STRANGER_IMAGE }],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('lets a moderator through without a lookup', async () => {
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        isModerator: true,
        showcaseItems: [{ entityType: 'Image', entityId: STRANGER_IMAGE }],
        currentShowcaseItems: [],
      })
    ).resolves.toBeUndefined();
    expect(db.image.findMany).not.toHaveBeenCalled();
  });
});

describe('updateUserProfile — showcase ownership', () => {
  it("refuses to store another user's image and writes nothing", async () => {
    await expect(
      updateUserProfile({
        userId: OWNER_ID,
        showcaseItems: [{ entityType: 'Image', entityId: STRANGER_IMAGE }],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('still saves a profile whose stored showcase holds a model since transferred away', async () => {
    const showcaseItems: ShowcaseItemSchema[] = [
      { entityType: 'Model', entityId: TRANSFERRED_MODEL },
    ];
    storeShowcase(showcaseItems);

    await expect(updateUserProfile({ userId: OWNER_ID, showcaseItems })).resolves.toBeDefined();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('addEntityToShowcaseHandler — ownership', () => {
  const ctxFor = (isModerator: boolean) =>
    ({ user: { id: OWNER_ID, isModerator }, domain: 'red' } as never);

  it("rejects a non-moderator adding another user's image", async () => {
    await expect(
      addEntityToShowcaseHandler({
        input: { entityType: 'Image', entityId: STRANGER_IMAGE },
        ctx: ctxFor(false),
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("lets a moderator add another user's image", async () => {
    await addEntityToShowcaseHandler({
      input: { entityType: 'Image', entityId: STRANGER_IMAGE },
      ctx: ctxFor(true),
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
