import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTO_FEATURE_NOTE_PREFIX } from '~/server/common/auto-feature';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `permissions.writeReview` is granted to every authenticated user on a `write: Review`
// collection (and `permissions.write` likewise on `write: Public`), independent of ownership.
// Removal must not accept those as authorization — a write grant lets you ADD an item, not
// delete somebody else's.

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

const ENTITY_DELEGATES = {
  Model: mockDbRead.model,
  Image: mockDbRead.image,
  Post: mockDbRead.post,
  Article: mockDbRead.article,
  Model3D: mockDbRead.model3D,
} as const;
type EntityType = keyof typeof ENTITY_DELEGATES;

// The $queryRaw is the permission row (getUserCollectionPermissionsByIds); the item owner comes
// from `itemType`'s table and ITEM_ID's row only, so a lookup in any other table, or of any other
// id, finds nothing.
function arrangeCollection({
  write,
  collectionType = 'Image',
  itemType = collectionType ?? 'Image',
  contributorPermissions = null,
  // Both nullable, and both NULL is the ordinary case — an item added by a since-deleted account
  // carries no addedById and most items carry no note.
  item = { id: ITEM_ROW_ID, addedById: null, note: null },
}: {
  write: 'Public' | 'Review' | 'Private';
  collectionType?: EntityType | null;
  itemType?: EntityType;
  contributorPermissions?: string[] | null;
  item?: { id: number; addedById: number | null; note: string | null };
}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbRead.user.findFirst.mockResolvedValue({ id: AUTO_FEATURE_USER_ID });
  mockDbWrite.$queryRaw.mockReset();
  mockDbWrite.collectionItem.updateMany.mockReset();
  mockDbWrite.collectionItem.deleteMany.mockReset();
  mockDbRead.$queryRaw.mockResolvedValueOnce([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write,
      userId: COLLECTION_OWNER_ID,
      type: collectionType,
      mode: 'Contest',
      contributorPermissions,
    },
  ]);
  for (const [entity, delegate] of Object.entries(ENTITY_DELEGATES)) {
    delegate.findUnique.mockReset();
    delegate.findUnique.mockImplementation((({ where }: { where: { id: number } }) =>
      Promise.resolve(
        entity === itemType && where.id === ITEM_ID ? { userId: ITEM_AUTHOR_ID } : null
      )) as never);
  }

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
    expect(rendered).toContain(
      `"collectionId" = ${COLLECTION_ID} AND "${itemType.toLowerCase()}Id" = ${ITEM_ID}`
    );
    return Promise.resolve([item]);
  });
}

/** Prisma passes `Prisma.raw` fragments through as values, not as template text. */
function render(value: unknown) {
  const fragment = (value as { strings?: string[] })?.strings;
  return Array.isArray(fragment) ? fragment.join('') : String(value);
}

function remove({
  userId,
  isModerator = false,
  type,
}: {
  userId: number;
  isModerator?: boolean;
  type?: EntityType;
}) {
  return removeCollectionItem({
    collectionId: COLLECTION_ID,
    itemId: ITEM_ID,
    type,
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

  // The save modal offers Remove on the strength of "you added this", so refusing it here left a
  // Contributor with a button that 401s.
  it('allows whoever added the row to remove it', async () => {
    arrangeCollection({
      write: 'Review',
      item: { id: ITEM_ROW_ID, addedById: OUTSIDER_ID, note: null },
    });

    await expect(remove({ userId: OUTSIDER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  // Removal takes every row for the entity, so holding one of them is not authorization over the
  // rest — otherwise adding a duplicate would be enough to delete someone else's entry.
  it('rejects a submitter when another row for the same entity is not theirs', async () => {
    arrangeCollection({ write: 'Review' });
    mockDbWrite.$queryRaw.mockResolvedValue([
      { id: ITEM_ROW_ID, addedById: OUTSIDER_ID, note: null },
      { id: ITEM_ROW_ID + 1, addedById: COLLECTION_OWNER_ID, note: null },
    ]);

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
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

// A type-NULL collection holds items of every type, so `itemId` alone does not say which table it
// is in; the caller's `type` does. A typed collection ignores the caller's `type`.
describe('removeCollectionItem entity type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes an item from a type-NULL collection using the type the caller names', async () => {
    arrangeCollection({ write: 'Private', collectionType: null, itemType: 'Model' });

    await expect(remove({ userId: COLLECTION_OWNER_ID, type: 'Model' })).resolves.toMatchObject({
      type: 'Model',
    });
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  // The caller's `type` now picks the table ownership is read from, so it needs its own controls.
  it('rejects an outsider on a type-NULL collection', async () => {
    arrangeCollection({ write: 'Public', collectionType: null, itemType: 'Model' });

    await expect(remove({ userId: OUTSIDER_ID, type: 'Model' })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.collectionItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it('allows the item author to remove their entry from a type-NULL collection', async () => {
    arrangeCollection({ write: 'Public', collectionType: null, itemType: 'Model' });

    await expect(remove({ userId: ITEM_AUTHOR_ID, type: 'Model' })).resolves.toBeTruthy();
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [ITEM_ROW_ID] } },
    });
  });

  it('rejects removal from a type-NULL collection when the caller names no type', async () => {
    arrangeCollection({ write: 'Private', collectionType: null });

    await expect(remove({ userId: COLLECTION_OWNER_ID })).rejects.toThrow(/type is required/i);
  });

  it("uses a typed collection's own type over the caller's", async () => {
    arrangeCollection({ write: 'Private', collectionType: 'Image' });

    await expect(remove({ userId: COLLECTION_OWNER_ID, type: 'Model' })).resolves.toMatchObject({
      type: 'Image',
    });
  });
});
