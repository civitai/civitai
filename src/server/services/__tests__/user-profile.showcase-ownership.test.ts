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
  setPinnedItem,
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
const OWN_TAKEN_DOWN_MODEL = 5;
const OWN_ARCHIVED_MODEL = 6;

const db = dbMock.dbWrite;

// Mirrors the `where: { id: { in }, userId }` filter: only rows belonging to the queried user return.
const ownedBy: Record<'image' | 'model', Record<number, number>> = {
  image: { [OWN_IMAGE]: OWNER_ID, [STRANGER_IMAGE]: STRANGER_ID },
  model: {
    [OWN_MODEL]: OWNER_ID,
    [TRANSFERRED_MODEL]: STRANGER_ID,
    [OWN_TAKEN_DOWN_MODEL]: OWNER_ID,
    [OWN_ARCHIVED_MODEL]: OWNER_ID,
  },
};
const modeOf: Record<number, string | null> = {
  [OWN_TAKEN_DOWN_MODEL]: 'TakenDown',
  [OWN_ARCHIVED_MODEL]: 'Archived',
};
// Mirrors `count({ where: { id: { in }, mode } })`.
const countWithMode = async ({ where }: { where: { id: { in: number[] }; mode: string } }) =>
  where.id.in.filter((id) => (modeOf[id] ?? null) === where.mode).length;
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
    cosmetics: [],
    profile: { userId: OWNER_ID, message: null, coverImage: null, showcaseItems },
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.image.findMany.mockImplementation(findOwned('image') as never);
  db.model.findMany.mockImplementation(findOwned('model') as never);
  db.model.count.mockImplementation(countWithMode as never);
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

  it.each([false, true])(
    "refuses a taken-down model, the owner's own included (moderator: %s)",
    async (isModerator) => {
      await expect(
        assertShowcaseItemsOwned({
          userId: OWNER_ID,
          isModerator,
          showcaseItems: [{ entityType: 'Model', entityId: OWN_TAKEN_DOWN_MODEL }],
          currentShowcaseItems: [],
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'A taken-down model cannot be showcased',
      });
    }
  );

  it("accepts the owner's archived model: only a takedown is refused", async () => {
    await expect(
      assertShowcaseItemsOwned({
        userId: OWNER_ID,
        showcaseItems: [{ entityType: 'Model', entityId: OWN_ARCHIVED_MODEL }],
        currentShowcaseItems: [],
      })
    ).resolves.toBeUndefined();
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
  it("lets a moderator editing another user's profile store an item that user does not own", async () => {
    await expect(
      updateUserProfile({
        userId: OWNER_ID,
        isModerator: true,
        sessionUserId: STRANGER_ID,
        showcaseItems: [{ entityType: 'Image', entityId: STRANGER_IMAGE }],
      })
    ).resolves.toBeDefined();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a moderator putting another user's image on their own profile", async () => {
    await expect(
      updateUserProfile({
        userId: OWNER_ID,
        isModerator: true,
        sessionUserId: OWNER_ID,
        showcaseItems: [{ entityType: 'Image', entityId: STRANGER_IMAGE }],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

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

describe('updateUserProfile — custom showcase placement rows', () => {
  it('keeps a row for an existing section and drops one that names no section', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue({
      id: OWNER_ID,
      meta: {},
      settings: {},
      publicSettings: {},
      cosmetics: [],
      profile: {
        userId: OWNER_ID,
        message: null,
        coverImage: null,
        showcaseItems: [],
        showcaseSections: [{ id: 'kept', type: 'Model', title: 'Kept', items: [OWN_MODEL] }],
      },
    });

    await updateUserProfile({
      userId: OWNER_ID,
      sessionUserId: OWNER_ID,
      profileSectionsSettings: [
        { key: 'custom:kept', enabled: true },
        { key: 'custom:ghost', enabled: true },
        { key: 'showcase', enabled: false },
      ],
    });

    expect(tx.userProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileSectionsSettings: [
            { key: 'custom:kept', enabled: true },
            { key: 'showcase', enabled: false },
          ],
        }),
      })
    );
  });
});

describe('updateUserProfile — custom placement rows without sections', () => {
  // A user who never created a section (the write is flag-gated) cannot store custom rows through
  // userProfile.update.
  it('drops every custom row when the profile has no showcase sections', async () => {
    storeShowcase([]);
    await updateUserProfile({
      userId: OWNER_ID,
      sessionUserId: OWNER_ID,
      profileSectionsSettings: [
        { key: 'custom:any', enabled: true },
        { key: 'showcase', enabled: true },
      ],
    });
    expect(tx.userProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileSectionsSettings: [{ key: 'showcase', enabled: true }],
        }),
      })
    );
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

  // The moderator exemption is for curating another user's showcase, never for a moderator's own.
  it("rejects a moderator adding another user's image to their own showcase", async () => {
    await expect(
      addEntityToShowcaseHandler({
        input: { entityType: 'Image', entityId: STRANGER_IMAGE },
        ctx: ctxFor(true),
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'lets the owner add their own model (moderator: %s)',
    async (isModerator) => {
      db.model.findUniqueOrThrow.mockResolvedValue({ id: OWN_MODEL } as never);
      dbMock.dbRead.model.findUniqueOrThrow.mockResolvedValue({ id: OWN_MODEL } as never);
      await addEntityToShowcaseHandler({
        input: { entityType: 'Model', entityId: OWN_MODEL },
        ctx: ctxFor(isModerator),
      });
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects the owner adding their own taken-down model', async () => {
    db.model.findUniqueOrThrow.mockResolvedValue({ id: OWN_TAKEN_DOWN_MODEL } as never);
    dbMock.dbRead.model.findUniqueOrThrow.mockResolvedValue({ id: OWN_TAKEN_DOWN_MODEL } as never);
    await expect(
      addEntityToShowcaseHandler({
        input: { entityType: 'Model', entityId: OWN_TAKEN_DOWN_MODEL },
        ctx: ctxFor(false),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('setPinnedItem', () => {
  let stored: ShowcaseItemSchema[];
  beforeEach(() => {
    stored = [];
    db.userProfile.findUnique.mockImplementation((async () => ({ pinnedItems: stored })) as never);
    db.userProfile.updateMany.mockImplementation((async ({ data }: never) => {
      stored = (data as { pinnedItems: ShowcaseItemSchema[] }).pinnedItems;
      return { count: 1 };
    }) as never);
  });
  const pin = (entityType: 'Image' | 'Model', entityId: number, pinned = true) =>
    setPinnedItem({ userId: OWNER_ID, entityType, entityId, pinned });

  it("pins the owner's own image and model, and unpins them", async () => {
    await pin('Image', OWN_IMAGE);
    await pin('Model', OWN_MODEL);
    expect(stored).toEqual([
      { entityType: 'Image', entityId: OWN_IMAGE },
      { entityType: 'Model', entityId: OWN_MODEL },
    ]);
    await pin('Image', OWN_IMAGE, false);
    expect(stored).toEqual([{ entityType: 'Model', entityId: OWN_MODEL }]);
  });

  it("refuses another user's image and writes nothing", async () => {
    await expect(pin('Image', STRANGER_IMAGE)).rejects.toThrow();
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a fourth pin instead of dropping one', async () => {
    stored = [
      { entityType: 'Image', entityId: 11 },
      { entityType: 'Image', entityId: 12 },
      { entityType: 'Image', entityId: 13 },
    ];
    await expect(pin('Image', OWN_IMAGE)).rejects.toThrow(/up to 3/);
    expect(stored).toHaveLength(3);
  });

  it('refuses a save over pins that changed since they were read', async () => {
    db.userProfile.updateMany.mockResolvedValue({ count: 0 } as never);
    await expect(pin('Image', OWN_IMAGE)).rejects.toThrow(/changed while saving/);
    expect(db.userProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER_ID, pinnedItems: { equals: [] } } })
    );
  });
});
