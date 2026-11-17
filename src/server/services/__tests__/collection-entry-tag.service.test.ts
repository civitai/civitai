import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

const { saveItemInCollections } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const AUTHOR_ID = 321;
const OTHER_ID = 555;
const IMAGE_ID = 42;
const TAG_A = 1;
const TAG_B = 2;
const SYSTEM_TAG = 9;

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
