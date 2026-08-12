import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTO_FEATURE_NOTE_PREFIX } from '~/server/common/auto-feature';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

// `permissions.writeReview` is granted to every authenticated user on a `write: Review`
// collection (and `permissions.write` likewise on `write: Public`), independent of ownership.
// Removal must not accept those as authorization — a write grant lets you ADD an item, not
// delete somebody else's.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn(), user: { findFirst: vi.fn() } },
  mockDbWrite: {
    $queryRaw: vi.fn(),
    collectionItem: { updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

const { removeCollectionItem } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const COLLECTION_OWNER_ID = 999;
const ITEM_AUTHOR_ID = 777;
const OUTSIDER_ID = 12_345;
const ITEM_ROW_ID = 4242;
const ITEM_ID = 55;
// Whatever id the attribution account happens to have in this database — the point of resolving
// it by username is that the code never assumes a particular number.
const AUTO_FEATURE_USER_ID = 987_654;

// First $queryRaw is the permission row (getUserCollectionPermissionsByIds), second is the
// item-owner lookup.
function arrangeCollection({
  write,
  contributorPermissions = null,
  // Both nullable, and both NULL is the ordinary case — an item added by a since-deleted account
  // carries no addedById and most items carry no note.
  item = { id: ITEM_ROW_ID, addedById: null, note: null },
}: {
  write: 'Public' | 'Review' | 'Private';
  contributorPermissions?: string[] | null;
  item?: { id: number; addedById: number | null; note: string | null };
}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbRead.user.findFirst.mockResolvedValue({ id: AUTO_FEATURE_USER_ID });
  mockDbWrite.$queryRaw.mockReset();
  mockDbWrite.collectionItem.updateMany.mockReset();
  mockDbWrite.collectionItem.deleteMany.mockReset();
  mockDbRead.$queryRaw
    .mockResolvedValueOnce([
      {
        id: COLLECTION_ID,
        read: 'Public',
        write,
        userId: COLLECTION_OWNER_ID,
        type: 'Image',
        mode: 'Contest',
        contributorPermissions,
      },
    ])
    .mockResolvedValueOnce([{ userId: ITEM_AUTHOR_ID }]);

  // The lookup's own WHERE clause is now the only thing deciding which rows the writes below
  // touch, and a mock that ignores its arguments cannot see it. Losing the entity predicate
  // returns the whole collection and the delete empties it; losing the collection predicate
  // removes the entity everywhere it appears. Both mutations leave every assertion in this file
  // green unless the fixture reads the statement it was asked for.
  mockDbWrite.$queryRaw.mockImplementation((strings: string[], ...values: unknown[]) => {
    const rendered = strings
      .map((chunk, i) => chunk + (i < values.length ? render(values[i]) : ''))
      .join('');
    // One assertion spanning both, because two independent `toContain`s prove the predicates are
    // present and not that they are conjoined: `AND` -> `OR` keeps both substrings and returns
    // the whole collection plus the image's rows everywhere else.
    expect(rendered).toContain(`"collectionId" = ${COLLECTION_ID} AND "imageId" = ${ITEM_ID}`);
    return Promise.resolve([item]);
  });
}

/** Prisma passes `Prisma.raw` fragments through as values, not as template text. */
function render(value: unknown) {
  const fragment = (value as { strings?: string[] })?.strings;
  return Array.isArray(fragment) ? fragment.join('') : String(value);
}

function remove({ userId, isModerator = false }: { userId: number; isModerator?: boolean }) {
  return removeCollectionItem({
    collectionId: COLLECTION_ID,
    itemId: ITEM_ID,
    userId,
    isModerator,
  } as never);
}

describe('removeCollectionItem authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an outsider on a write:Review collection', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an outsider on a write:Public collection', async () => {
    arrangeCollection({ write: 'Public' });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a contributor holding only ADD on a write:Public collection', async () => {
    arrangeCollection({ write: 'Public', contributorPermissions: ['ADD'] });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an outsider on a write:Private collection', async () => {
    arrangeCollection({ write: 'Private' });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('allows the item author to remove their own entry', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: ITEM_AUTHOR_ID })).resolves.toMatchObject({
      collectionId: COLLECTION_ID,
      itemId: 55,
    });
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  it('allows the collection owner to remove any entry', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  it('allows a moderator to remove any entry', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: OUTSIDER_ID, isModerator: true })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  it('allows a contributor holding MANAGE to remove any entry', async () => {
    arrangeCollection({ write: 'Review', contributorPermissions: ['MANAGE'] });

    await expect(remove({ userId: OUTSIDER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  // An auto-featured item is rejected, never deleted: the job's dedupe is "does a row exist",
  // so deleting the row would let the next run put the same image straight back.
  it('rejects an auto-featured item rather than deleting it', async () => {
    arrangeCollection({
      write: 'Review',
      item: {
        id: ITEM_ROW_ID,
        addedById: AUTO_FEATURE_USER_ID,
        note: `${AUTO_FEATURE_NOTE_PREFIX}:1234`,
      },
    });

    await expect(remove({ userId: OUTSIDER_ID, isModerator: true })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
      data: expect.objectContaining({
        status: CollectionItemStatus.REJECTED,
        reviewedById: OUTSIDER_ID,
      }),
    });
  });

  // Regression: expressing "is this auto-featured" as a SQL predicate made removal a silent
  // no-op for every row with a NULL note — the ordinary case — because NOT (x AND NULL) is NULL
  // rather than TRUE. 10,000+ rows across 3,946 collections on prod, all reporting success and
  // staying put. The default fixture is that row.
  it('deletes a row whose addedById and note are both null', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  // Attribution alone must not tombstone: CivitaiOfficial curates by hand too, and those adds
  // carry no auto-feature note.
  it('deletes a CivitaiOfficial item that was not added by the job', async () => {
    arrangeCollection({
      write: 'Review',
      item: { id: ITEM_ROW_ID, addedById: AUTO_FEATURE_USER_ID, note: 'contest entry' },
    });

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  // Resolving by username means the account can be absent — a fresh dev database has no
  // CivitaiOfficial. Removal then behaves exactly as it did before this feature rather than
  // tombstoning rows nothing will ever re-approve.
  it('deletes an auto-shaped row when the attribution account does not exist', async () => {
    arrangeCollection({
      write: 'Review',
      item: {
        id: ITEM_ROW_ID,
        addedById: AUTO_FEATURE_USER_ID,
        note: `${AUTO_FEATURE_NOTE_PREFIX}:1234`,
      },
    });
    mockDbRead.user.findFirst.mockResolvedValue(null);

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  it('does nothing when the item is not in the collection', async () => {
    arrangeCollection({ write: 'Review' });
    mockDbWrite.$queryRaw.mockResolvedValue([]);

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });
});
