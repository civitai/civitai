import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';

// Re-saving an item already in a collection with a different tag: who may change the entry's tag.

const { createNotification } = vi.hoisted(() => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification }));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  assertImagesVisibleToViewer: vi.fn(),
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  homeBlockCacheBust: vi.fn(),
}));

// Replica-lag routing is on for this file (the lag tracker reads the delay once, at load): a read
// goes to the primary only for an entry a test flags as just written.
envMock.set({ REPLICATION_LAG_DELAY: 3 });
const { bulkSaveItems, saveItemInCollections } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const AUTHOR_ID = 321;
const OTHER_ID = 555;
const IMAGE_ID = 42;
const TAG_A = 1;
const TAG_B = 2;
const SYSTEM_TAG = 9;
const SYSTEM_TAG_2 = 8;

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const collectionRow = (metadata: Record<string, unknown> = {}) => ({
  id: COLLECTION_ID,
  name: 'Tagged collection',
  description: null,
  read: 'Public',
  write: 'Public',
  type: 'Image',
  nsfw: false,
  nsfwLevel: 0,
  image: null,
  mode: null,
  metadata,
  availability: 'Public',
  userId: OWNER_ID,
  tags: [
    { tag: { id: TAG_A, name: 'A' }, filterableOnly: false },
    { tag: { id: TAG_B, name: 'B' }, filterableOnly: false },
    { tag: { id: SYSTEM_TAG, name: 'Judged' }, filterableOnly: true },
    { tag: { id: SYSTEM_TAG_2, name: 'Review me' }, filterableOnly: true },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.collection.findMany.mockResolvedValue([collectionRow()]);
  mockDbRead.collectionItem.findMany.mockResolvedValue([
    { id: 7, collectionId: COLLECTION_ID, tagId: TAG_A, addedById: AUTHOR_ID, note: null },
  ]);
  mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
  mockDbRead.challengeJudge.findMany.mockResolvedValue([]);
  // getUserCollectionPermissionsByIds: a collection anyone may add to.
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
});

const resave = (userId: number, tagId: number | undefined, isModerator?: boolean) =>
  saveItemInCollections({
    input: {
      type: 'Image',
      userId,
      isModerator,
      imageId: IMAGE_ID,
      collections: [{ collectionId: COLLECTION_ID, tagId }],
      removeFromCollectionIds: [],
    } as never,
  });

/** The tag the upsert writes for the entry. */
const writtenTag = () => {
  const [, ...values] = mockDbWrite.$executeRaw.mock.calls[0] as unknown[];
  const json = values.find((v) => typeof v === 'string' && v.includes('"collectionId"'));
  const [row] = JSON.parse(json as string) as { tagId?: number | null }[];
  return row.tagId ?? null;
};

describe('re-saving an entry with a different tag', () => {
  it("keeps the entry's tag when someone else re-saves it", async () => {
    await resave(OTHER_ID, TAG_B);
    expect(writtenTag()).toBe(TAG_A);
  });

  it("keeps the entry's tag when someone else re-saves it with none", async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ disableTagRequired: true })]);
    await resave(OTHER_ID, undefined);
    expect(writtenTag()).toBe(TAG_A);
  });

  it("changes it for the entry's author (control)", async () => {
    await resave(AUTHOR_ID, TAG_B);
    expect(writtenTag()).toBe(TAG_B);
  });

  it("changes it for the collection's manager (control)", async () => {
    await resave(OWNER_ID, TAG_B);
    expect(writtenTag()).toBe(TAG_B);
  });

  it('changes it for a moderator (control)', async () => {
    await resave(OTHER_ID, TAG_B, true);
    expect(writtenTag()).toBe(TAG_B);
  });

  it('has the upsert change the tag only for the row author or a managed collection', async () => {
    await resave(OWNER_ID, TAG_B);
    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toContain(
      'DO UPDATE SET "tagId" = EXCLUDED."tagId" WHERE ( "CollectionItem"."addedById" = EXCLUDED."addedById" OR "CollectionItem"."collectionId" = ANY(?::int[]) ) AND ( "CollectionItem"."tagId" IS NULL OR EXISTS ('
    );
    expect(sql).toContain('AND NOT tc."filterableOnly"');
    expect(values.at(-1)).toEqual([COLLECTION_ID]);

    mockDbWrite.$executeRaw.mockClear();
    await resave(OTHER_ID, TAG_B);
    const [, ...strangerValues] = mockDbWrite.$executeRaw.mock.calls[0] as unknown[];
    expect(strangerValues.at(-1)).toEqual([]);
  });

  it('keeps a tag the collection does not list when its author re-saves the entry', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ disableTagRequired: true })]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: 77, addedById: AUTHOR_ID, note: null },
    ]);
    await resave(AUTHOR_ID, undefined);
    expect(writtenTag()).toBe(77);
  });

  it.each([
    ['its author', AUTHOR_ID, undefined],
    ['its author, with another tag', AUTHOR_ID, TAG_B],
    ['a manager', OWNER_ID, TAG_B],
  ])('keeps a system tag when %s re-saves the entry', async (_, userId, tagId) => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ disableTagRequired: true })]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: SYSTEM_TAG, addedById: AUTHOR_ID, note: null },
    ]);
    await resave(userId, tagId);
    expect(writtenTag()).toBe(SYSTEM_TAG);
  });

  it('tags a new entry as asked (control)', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    await resave(OTHER_ID, TAG_B);
    expect(writtenTag()).toBe(TAG_B);
  });
});

describe('a collection that reviews entries', () => {
  beforeEach(() => {
    mockDbRead.collection.findMany.mockResolvedValue([{ ...collectionRow(), write: 'Review' }]);
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        id: COLLECTION_ID,
        read: 'Public',
        write: 'Review',
        userId: OWNER_ID,
        type: 'Image',
        mode: null,
        contributorPermissions: null,
        collaborationDisabledAt: null,
      },
    ]);
  });

  it("does not announce someone else's re-save with another tag as a new submission", async () => {
    await resave(OTHER_ID, TAG_B);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('announces a new entry (control)', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    await resave(OTHER_ID, TAG_B);
    expect(createNotification).toHaveBeenCalled();
  });
});

describe('a system tag on a new entry', () => {
  const OTHER_COLLECTION_ID = 99;

  it('refuses a new entry tagged with a system tag', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    await expect(resave(OTHER_ID, SYSTEM_TAG)).rejects.toMatchObject({
      message: 'Provided tag is not part of this collection',
    });
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses it when the item holds that tag in another collection only', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      {
        id: 8,
        collectionId: OTHER_COLLECTION_ID,
        tagId: SYSTEM_TAG,
        addedById: AUTHOR_ID,
        note: null,
      },
    ]);
    await expect(resave(AUTHOR_ID, SYSTEM_TAG)).rejects.toMatchObject({
      message: 'Provided tag is not part of this collection',
    });
  });

  it("accepts a re-save that sends the entry's own system tag back", async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ disableTagRequired: true })]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: SYSTEM_TAG, addedById: AUTHOR_ID, note: null },
    ]);
    await resave(AUTHOR_ID, SYSTEM_TAG);
    expect(writtenTag()).toBe(SYSTEM_TAG);
  });
});

describe('bulkSaveItems and a system tag', () => {
  const NEW_IMAGE = 43;
  const PERMISSIONS = { isContributor: true, isOwner: false, manage: false, write: true } as never;
  const bulk = (tagId: number, imageIds: number[]) =>
    bulkSaveItems({
      input: { collectionId: COLLECTION_ID, imageIds, tagId, userId: AUTHOR_ID } as never,
      permissions: PERMISSIONS,
    });

  beforeEach(() => {
    mockDbRead.collection.findUnique.mockResolvedValue(collectionRow());
    mockDbRead.collection.findFirst.mockResolvedValue(collectionRow());
    mockDbWrite.collectionItem.createMany.mockResolvedValue({ count: 1 });
    // Only IMAGE_ID is already in the collection.
    mockDbRead.collectionItem.findMany.mockImplementation((async (args: any) =>
      args?.where?.imageId?.in?.includes(IMAGE_ID) ? [{ imageId: IMAGE_ID }] : []) as never);
  });

  it('refuses a new image tagged with a system tag, as when a post edit adds one', async () => {
    await expect(bulk(SYSTEM_TAG, [IMAGE_ID, NEW_IMAGE])).rejects.toMatchObject({
      message: 'The tag provided is not allowed in this collection',
    });
    expect(mockDbWrite.collectionItem.createMany).not.toHaveBeenCalled();
  });

  it('accepts a re-save whose items are all in the collection already', async () => {
    await bulk(SYSTEM_TAG, [IMAGE_ID]);
    expect(mockDbWrite.collectionItem.createMany).toHaveBeenCalledWith({ data: [] });
  });

  it('writes a new image with a category tag (control)', async () => {
    await bulk(TAG_B, [IMAGE_ID, NEW_IMAGE]);
    expect(mockDbWrite.collectionItem.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ imageId: NEW_IMAGE, tagId: TAG_B })],
    });
  });
});

describe('a system tag sent back for an entry that already exists', () => {
  const SECOND_COLLECTION_ID = 11;
  const saveTo = (userId: number, collections: { collectionId: number; tagId?: number }[]) =>
    saveItemInCollections({
      input: {
        type: 'Image',
        userId,
        imageId: IMAGE_ID,
        collections,
        removeFromCollectionIds: [],
      } as never,
    });
  const writtenRows = () => {
    const [, ...values] = mockDbWrite.$executeRaw.mock.calls[0] as unknown[];
    const json = values.find((v) => typeof v === 'string' && v.includes('"collectionId"'));
    return JSON.parse(json as string) as { collectionId: number; tagId?: number | null }[];
  };

  beforeEach(() => {
    mockDbRead.collection.findMany.mockResolvedValue([
      collectionRow({ disableTagRequired: true }),
      { ...collectionRow({ disableTagRequired: true }), id: SECOND_COLLECTION_ID, tags: [] },
    ]);
    mockDbRead.$queryRaw.mockResolvedValue(
      [COLLECTION_ID, SECOND_COLLECTION_ID].map((id) => ({
        id,
        read: 'Public',
        write: 'Public',
        userId: OWNER_ID,
        type: 'Image',
        mode: null,
        contributorPermissions: null,
        collaborationDisabledAt: null,
      }))
    );
  });

  it('keeps the stored system tag, and saves the rest of the request', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: SYSTEM_TAG_2, addedById: AUTHOR_ID, note: null },
    ]);
    await saveTo(AUTHOR_ID, [
      { collectionId: COLLECTION_ID, tagId: SYSTEM_TAG },
      { collectionId: SECOND_COLLECTION_ID },
    ]);
    const rows = writtenRows();
    expect(rows.find((r) => r.collectionId === COLLECTION_ID)?.tagId).toBe(SYSTEM_TAG_2);
    expect(rows.some((r) => r.collectionId === SECOND_COLLECTION_ID)).toBe(true);
  });

  it('refuses it for an entry holding a category tag', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ disableTagRequired: true })]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: TAG_A, addedById: AUTHOR_ID, note: null },
    ]);
    await expect(
      saveTo(AUTHOR_ID, [{ collectionId: COLLECTION_ID, tagId: SYSTEM_TAG }])
    ).rejects.toMatchObject({
      message: 'Provided tag is not part of this collection',
    });
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('the existing entry, read right after a write', () => {
  // The replica still has the entry with its system tag; the primary has it removed.
  beforeEach(() => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: SYSTEM_TAG, addedById: AUTHOR_ID, note: null },
    ]);
    mockDbWrite.collectionItem.findMany.mockResolvedValue([]);
  });

  it('is read from the primary while the entry is flagged as just written', async () => {
    redisMock.redis.get.mockImplementation((async (key: string) =>
      String(key).includes(`collectionItem:${COLLECTION_ID}:imageId:${IMAGE_ID}`)
        ? '1'
        : null) as never);
    await expect(resave(AUTHOR_ID, SYSTEM_TAG)).rejects.toMatchObject({
      message: 'Provided tag is not part of this collection',
    });
    expect(mockDbWrite.collectionItem.findMany).toHaveBeenCalled();
  });

  it('is flagged as just written once a save lands', async () => {
    redisMock.redis.get.mockResolvedValue(null as never);
    await resave(AUTHOR_ID, TAG_B);
    expect(redisMock.redis.set).toHaveBeenCalledWith(
      expect.stringContaining(`collectionItem:${COLLECTION_ID}:imageId:${IMAGE_ID}`),
      expect.anything(),
      expect.anything()
    );
  });

  it('is read from the replica otherwise (control)', async () => {
    redisMock.redis.get.mockResolvedValue(null as never);
    await resave(AUTHOR_ID, SYSTEM_TAG);
    expect(mockDbWrite.collectionItem.findMany).not.toHaveBeenCalled();
    expect(writtenTag()).toBe(SYSTEM_TAG);
  });
});

describe('the entry write itself, run on Postgres', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.exec(`
      CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
      CREATE TABLE "TagsOnCollection" ("collectionId" int, "tagId" int, "filterableOnly" boolean);
      CREATE TABLE "CollectionItem" (
        id serial PRIMARY KEY, "collectionId" int, "addedById" int,
        status "CollectionItemStatus", "imageId" int, "tagId" int
      );
      CREATE UNIQUE INDEX ON "CollectionItem" ("collectionId", "imageId") WHERE "imageId" IS NOT NULL;
      INSERT INTO "TagsOnCollection" VALUES
        (${COLLECTION_ID}, ${TAG_A}, false), (${COLLECTION_ID}, ${TAG_B}, false),
        (${COLLECTION_ID}, ${SYSTEM_TAG}, true);
    `);
  });
  afterAll(() => pg.close());

  // The save as the service builds it, then that statement run on the given table state.
  const runSave = async (tagId: number, stored: { tagId: number | null } | null) => {
    await pg.exec('DELETE FROM "CollectionItem"');
    if (stored)
      await pg.query(
        'INSERT INTO "CollectionItem" ("collectionId", "addedById", status, "imageId", "tagId") VALUES ($1, $2, $3, $4, $5)',
        [COLLECTION_ID, AUTHOR_ID, 'ACCEPTED', IMAGE_ID, stored.tagId]
      );
    await resave(AUTHOR_ID, tagId);
    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const query = Prisma.sql(strings, ...values);
    await pg.query(query.text, query.values as unknown[]);
    return (await pg.query<{ tagId: number | null }>('SELECT "tagId" FROM "CollectionItem"')).rows;
  };

  // The read below still shows the entry with its system tag (a stale replica): the service sends it.
  beforeEach(() => {
    mockDbRead.collection.findMany.mockResolvedValue([collectionRow({ disableTagRequired: true })]);
    mockDbRead.collectionItem.findMany.mockResolvedValue([
      { id: 7, collectionId: COLLECTION_ID, tagId: SYSTEM_TAG, addedById: AUTHOR_ID, note: null },
    ]);
  });

  it('does not re-create a removed entry with its old system tag', async () => {
    expect(await runSave(SYSTEM_TAG, null)).toEqual([]);
  });

  it('does not put a system tag back on an entry whose tag was cleared', async () => {
    expect(await runSave(SYSTEM_TAG, { tagId: null })).toEqual([{ tagId: null }]);
  });

  it('writes a category tag (control)', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    expect(await runSave(TAG_B, null)).toEqual([{ tagId: TAG_B }]);
  });
});
