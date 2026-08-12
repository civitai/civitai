import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AUTO_FEATURE_NOTE_PREFIX,
  AUTO_FEATURE_USER_ID,
} from '~/server/common/auto-feature.constants';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

// `permissions.writeReview` is granted to every authenticated user on a `write: Review`
// collection (and `permissions.write` likewise on `write: Public`), independent of ownership.
// Removal must not accept those as authorization — a write grant lets you ADD an item, not
// delete somebody else's.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
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
  mockDbWrite.$queryRaw.mockResolvedValue([item]);
}

function remove({ userId, isModerator = false }: { userId: number; isModerator?: boolean }) {
  return removeCollectionItem({
    collectionId: COLLECTION_ID,
    itemId: 55,
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

  it('does nothing when the item is not in the collection', async () => {
    arrangeCollection({ write: 'Review' });
    mockDbWrite.$queryRaw.mockResolvedValue([]);

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });
});
