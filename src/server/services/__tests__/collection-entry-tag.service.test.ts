import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as SearchIndex from '~/server/search-index';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';

// Re-saving an item already in a collection with a different tag: who may change the entry's tag.

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

const resave = (userId: number, tagId: number | undefined) =>
  saveItemInCollections({
    input: {
      type: 'Image',
      userId,
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

  it('tags a new entry as asked (control)', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    await resave(OTHER_ID, TAG_B);
    expect(writtenTag()).toBe(TAG_B);
  });
});
