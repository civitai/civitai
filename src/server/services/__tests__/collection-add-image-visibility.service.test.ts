import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// Adding an image to a collection refuses an image the caller couldn't open, before anything is
// written or followed. The visibility rule itself is covered in
// image-ids-visible-to-viewer.behavior.test.ts. Here HIDDEN_IMAGE opens only for its owner and staff.

const HIDDEN_IMAGE = 66;
const HIDDEN_IMAGE_OWNER = 321;
const VISIBLE_IMAGE = 42;

const { assertVisible } = vi.hoisted(() => ({
  assertVisible: vi.fn(
    async ({
      ids,
      userId,
      isModerator,
    }: {
      ids: number[];
      userId?: number;
      isModerator?: boolean;
    }) => {
      if (ids.includes(66) && userId !== 321 && !isModerator)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Image not found' });
    }
  ),
}));
import { PGlite } from '@electric-sql/pglite';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

// The withheld rule reads its own database, where nothing is withheld.
const withheld = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => withheld.db);
  return { kyselyRead: db, kyselyWrite: db };
});
beforeAll(async () => {
  withheld.db = new PGlite();
  await withheld.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    ${WITHHELD_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint, "postId" int);
  `);
}, 60_000);

vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  assertImagesVisibleToViewer: assertVisible,
}));
const { createNotification } = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification }));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: vi.fn(),
}));

const { saveItemInCollections, bulkSaveItems, upsertCollection } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const SUBMITTER_ID = 555;

const collectionRow = {
  id: COLLECTION_ID,
  name: 'Someone else’s collection',
  description: null,
  read: 'Public',
  write: 'Public',
  type: 'Image',
  nsfw: false,
  nsfwLevel: 0,
  image: null,
  mode: null,
  metadata: {},
  availability: 'Public',
  userId: OWNER_ID,
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.collection.findMany.mockResolvedValue([collectionRow]);
  mockDbRead.collection.findUnique.mockResolvedValue(collectionRow);
  mockDbRead.collectionItem.findMany.mockResolvedValue([]);
  mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
  mockDbRead.challengeJudge.findMany.mockResolvedValue([]);
  // getUserCollectionPermissionsByIds: a Public-write collection the submitter doesn't follow yet.
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Public',
      userId: OWNER_ID,
      type: 'Image',
      mode: null,
      contributorPermissions: null,
      collaborationDisabledAt: null,
    },
  ]);
  mockDbWrite.$executeRaw.mockReturnValue('insert' as never);
  mockDbWrite.$transaction.mockResolvedValue([]);
  mockDbWrite.collectionItem.createMany.mockResolvedValue({ count: 1 });
});

const save = (input: Record<string, unknown>) =>
  saveItemInCollections({
    input: { type: 'Image', userId: SUBMITTER_ID, removeFromCollectionIds: [], ...input } as never,
  });

describe('saveItemInCollections with an image', () => {
  it('refuses an image the caller cannot open, and writes and follows nothing', async () => {
    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });

  it('adds an image the caller can open', async () => {
    await expect(
      save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).resolves.toBe('added');
    expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['its owner', { userId: HIDDEN_IMAGE_OWNER }],
    ['staff', { isModerator: true }],
  ])('lets %s add an image others cannot open', async (_, viewer) => {
    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }], ...viewer })
    ).resolves.toBe('added');
    expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses before a contest is consulted', async () => {
    // A closed contest refuses with BAD_REQUEST; reaching it first would surface that instead.
    mockDbRead.collection.findMany.mockResolvedValue([
      {
        ...collectionRow,
        mode: 'Contest',
        metadata: { submissionEndDate: new Date(Date.now() - 86_400_000).toISOString() },
      },
    ]);
    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('still removes an image that has since become hidden', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: SUBMITTER_ID, note: null },
    ]);
    mockDbWrite.collectionItem.deleteMany.mockReturnValue('delete' as never);

    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [], removeFromCollectionIds: [COLLECTION_ID] })
    ).resolves.toBeDefined();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalled();
  });

  it('does not fail a re-save of membership the image already has', async () => {
    // Callers send the item's whole membership; an unchanged entry writes nothing new.
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: SUBMITTER_ID, note: null },
    ]);

    await expect(
      save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).resolves.toBeDefined();
  });

  it('refuses a caller who cannot add to the collection the same way whether or not the image is in it', async () => {
    const privateRow = { ...collectionRow, read: 'Private', write: 'Private' };
    mockDbRead.collection.findMany.mockResolvedValue([privateRow]);
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        id: COLLECTION_ID,
        read: 'Private',
        write: 'Private',
        userId: OWNER_ID,
        type: 'Image',
        mode: null,
        contributorPermissions: null,
        collaborationDisabledAt: null,
      },
    ]);
    const refusal = async (listed: boolean) => {
      mockDbRead.collectionItem.findMany.mockResolvedValue(
        listed
          ? [{ id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: OWNER_ID, note: null }]
          : []
      );
      return save({ imageId: HIDDEN_IMAGE, collections: [{ collectionId: COLLECTION_ID }] }).then(
        () => 'saved',
        (error: TRPCError) => ({ code: error.code, message: error.message })
      );
    };

    const notListed = await refusal(false);
    expect(notListed).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await refusal(true)).toEqual(notListed);
    expect(assertVisible).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('does not consult a contest the caller cannot add to', async () => {
    // A closed contest refuses with BAD_REQUEST, and its checks can charge an entry fee.
    mockDbRead.collection.findMany.mockResolvedValue([
      {
        ...collectionRow,
        read: 'Private',
        write: 'Private',
        mode: 'Contest',
        metadata: { submissionEndDate: new Date(Date.now() - 86_400_000).toISOString() },
      },
    ]);
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        id: COLLECTION_ID,
        read: 'Private',
        write: 'Private',
        userId: OWNER_ID,
        type: 'Image',
        mode: 'Contest',
        contributorPermissions: null,
        collaborationDisabledAt: null,
      },
    ]);
    await expect(
      save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  describe('a contest anyone may enter but only its owner may browse', () => {
    const closedContest = {
      ...collectionRow,
      read: 'Private',
      write: 'Public',
      mode: 'Contest',
      metadata: { submissionEndDate: new Date(Date.now() - 86_400_000).toISOString() },
    };
    beforeEach(() => {
      mockDbRead.collection.findMany.mockResolvedValue([closedContest]);
      mockDbRead.$queryRaw.mockResolvedValue([
        {
          id: COLLECTION_ID,
          read: 'Private',
          write: 'Public',
          userId: OWNER_ID,
          type: 'Image',
          mode: 'Contest',
          contributorPermissions: null,
          collaborationDisabledAt: null,
        },
      ]);
    });
    const entry = (addedById: number) => [
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById, note: null },
    ];
    const outcome = () =>
      save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] }).then(
        () => 'saved',
        (error: TRPCError) => ({ code: error.code, message: error.message })
      );

    it("answers the same whether or not someone else's image is entered", async () => {
      mockDbRead.collectionItem.findMany.mockResolvedValue([]);
      const notEntered = await outcome();
      expect(notEntered).toMatchObject({ code: 'BAD_REQUEST' });
      mockDbRead.collectionItem.findMany.mockResolvedValue(entry(OWNER_ID));
      expect(await outcome()).toEqual(notEntered);
    });

    it('still lets a submitter re-save their own entry after it closes (control)', async () => {
      mockDbRead.collectionItem.findMany.mockResolvedValue(entry(SUBMITTER_ID));
      expect(await outcome()).toBe('saved');
    });
  });

  it('re-saves an entry in a contest whose items the caller can read, without its checks', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([
      {
        ...collectionRow,
        mode: 'Contest',
        metadata: { submissionEndDate: new Date(Date.now() - 86_400_000).toISOString() },
      },
    ]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: OWNER_ID, note: null },
    ]);
    await expect(
      save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] })
    ).resolves.toBe('added');
  });

  it("does not announce a re-save of someone else's entry as a submission", async () => {
    mockDbRead.collection.findMany.mockResolvedValue([
      { ...collectionRow, read: 'Private', write: 'Review' },
    ]);
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        id: COLLECTION_ID,
        read: 'Private',
        write: 'Review',
        userId: OWNER_ID,
        type: 'Image',
        mode: null,
        contributorPermissions: null,
        collaborationDisabledAt: null,
      },
    ]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: null, addedById: OWNER_ID, note: null },
    ]);
    await save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] });
    expect(createNotification).not.toHaveBeenCalled();

    // Control: a new entry is announced.
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    await save({ imageId: VISIBLE_IMAGE, collections: [{ collectionId: COLLECTION_ID }] });
    expect(createNotification).toHaveBeenCalled();
  });
});

const bulk = (imageIds: number[], userId = SUBMITTER_ID) =>
  bulkSaveItems({
    input: { collectionId: COLLECTION_ID, imageIds, userId } as never,
    permissions: {
      collectionId: COLLECTION_ID,
      read: true,
      write: true,
      writeReview: false,
      manage: false,
      follow: true,
      isContributor: false,
      isOwner: false,
      isCollaborator: false,
    } as never,
  });

describe('bulkSaveItems with images', () => {
  it('refuses the batch when any image is one the caller cannot open, before following', async () => {
    await expect(bulk([VISIBLE_IMAGE, HIDDEN_IMAGE])).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockDbWrite.collectionItem.createMany).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });

  it('adds images the caller can open', async () => {
    await expect(bulk([VISIBLE_IMAGE])).resolves.toMatchObject({ imageIds: [VISIBLE_IMAGE] });
  });

  it('lets staff add an image others cannot open', async () => {
    await expect(
      bulkSaveItems({
        input: {
          collectionId: COLLECTION_ID,
          imageIds: [HIDDEN_IMAGE],
          userId: SUBMITTER_ID,
          isModerator: true,
        } as never,
        permissions: {
          collectionId: COLLECTION_ID,
          read: true,
          write: true,
          writeReview: false,
          manage: false,
          follow: true,
          isContributor: true,
          isOwner: false,
          isCollaborator: false,
        } as never,
      })
    ).resolves.toMatchObject({ imageIds: [HIDDEN_IMAGE] });
  });

  it("lets the image's owner add it", async () => {
    await expect(bulk([HIDDEN_IMAGE], HIDDEN_IMAGE_OWNER)).resolves.toMatchObject({
      imageIds: [HIDDEN_IMAGE],
    });
  });

  it('refuses before a contest is consulted', async () => {
    mockDbRead.collection.findUnique.mockResolvedValue({
      ...collectionRow,
      mode: 'Contest',
      metadata: { submissionEndDate: new Date(Date.now() - 86_400_000).toISOString() },
    });
    await expect(bulk([HIDDEN_IMAGE])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('upsertCollection creating a collection with a first image', () => {
  const create = (imageId: number) =>
    upsertCollection({
      input: { name: 'Mine', type: 'Image', read: 'Public', imageId, userId: SUBMITTER_ID },
    } as never);

  it('refuses an image the caller cannot open, and creates nothing', async () => {
    await expect(create(HIDDEN_IMAGE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDbWrite.collection.create).not.toHaveBeenCalled();
  });

  it('creates the collection with an image the caller can open', async () => {
    mockDbWrite.collection.create.mockResolvedValue({ id: 77, userId: SUBMITTER_ID } as never);
    await create(VISIBLE_IMAGE).catch(() => undefined);
    expect(mockDbWrite.collection.create).toHaveBeenCalledTimes(1);
  });
});
