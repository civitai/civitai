import { describe, it, expect, vi, beforeEach } from 'vitest';

// `permissions.writeReview` is granted to every authenticated user on a `write: Review`
// collection (and `permissions.write` likewise on `write: Public`), independent of ownership.
// Removal must not accept those as authorization — a write grant lets you ADD an item, not
// delete somebody else's.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn() },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

const { removeCollectionItem } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const COLLECTION_OWNER_ID = 999;
const ITEM_AUTHOR_ID = 777;
const OUTSIDER_ID = 12_345;

// First $queryRaw is the permission row (getUserCollectionPermissionsByIds), second is the
// item-owner lookup.
function arrangeCollection({
  write,
  contributorPermissions = null,
}: {
  write: 'Public' | 'Review' | 'Private';
  contributorPermissions?: string[] | null;
}) {
  mockDbRead.$queryRaw.mockReset();
  mockDbWrite.$queryRaw.mockReset();
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
  mockDbWrite.$queryRaw.mockResolvedValue(undefined);
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
    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an outsider on a write:Public collection', async () => {
    arrangeCollection({ write: 'Public' });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects a contributor holding only ADD on a write:Public collection', async () => {
    arrangeCollection({ write: 'Public', contributorPermissions: ['ADD'] });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an outsider on a write:Private collection', async () => {
    arrangeCollection({ write: 'Private' });

    await expect(remove({ userId: OUTSIDER_ID })).rejects.toThrow(/permission/i);
    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('allows the item author to remove their own entry', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: ITEM_AUTHOR_ID })).resolves.toMatchObject({
      collectionId: COLLECTION_ID,
      itemId: 55,
    });
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('allows the collection owner to remove any entry', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: COLLECTION_OWNER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('allows a moderator to remove any entry', async () => {
    arrangeCollection({ write: 'Review' });

    await expect(remove({ userId: OUTSIDER_ID, isModerator: true })).resolves.toBeTruthy();
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('allows a contributor holding MANAGE to remove any entry', async () => {
    arrangeCollection({ write: 'Review', contributorPermissions: ['MANAGE'] });

    await expect(remove({ userId: OUTSIDER_ID })).resolves.toBeTruthy();
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
