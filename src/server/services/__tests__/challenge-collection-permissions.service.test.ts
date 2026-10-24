import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const JUDGE_USER_ID = 8_675_309;
const CREATOR_USER_ID = 42;
const COLLECTION_ID = 10;

const {
  getUserCollectionPermissionsById,
  updateCollectionItemsStatus,
  deleteCollectionById,
  upsertCollection,
} = await import('~/server/services/collection.service');

// A challenge entry collection as created after this change: owned by the judge account,
// publicly readable, entries land in review.
function mockJudgeOwnedCollectionRow() {
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Review',
      userId: JUDGE_USER_ID,
      type: 'Image',
      mode: 'Contest',
      contributorPermissions: null,
    },
  ]);
}

describe('challenge collection permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJudgeOwnedCollectionRow();
  });

  it('gives the challenge creator no ownership and no manage rights', async () => {
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: CREATOR_USER_ID,
    });

    expect(permissions.isOwner).toBe(false);
    expect(permissions.manage).toBe(false);
  });

  it('still gives the judge account ownership', async () => {
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: JUDGE_USER_ID,
    });

    expect(permissions.isOwner).toBe(true);
    expect(permissions.manage).toBe(true);
  });

  it('still gives moderators manage rights', async () => {
    const permissions = await getUserCollectionPermissionsById({
      id: COLLECTION_ID,
      userId: CREATOR_USER_ID,
      isModerator: true,
    });

    expect(permissions.manage).toBe(true);
  });

  it('rejects the creator hand-reviewing entries', async () => {
    mockDbWrite.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      type: 'Image',
      mode: 'Contest',
      name: 'Challenge: Test',
      metadata: {},
    });

    await expect(
      updateCollectionItemsStatus({
        input: { collectionId: COLLECTION_ID, collectionItemIds: [1], status: 'ACCEPTED' },
        userId: CREATOR_USER_ID,
      } as never)
    ).rejects.toThrow(/permission/i);
  });

  it('rejects the creator deleting the collection', async () => {
    // deleteCollectionById scopes its own find by { id, userId } rather than going through
    // getUserCollectionPermissionsById, so the creator's read just finds no matching row.
    const notFound = new Error('No Collection found');
    mockDbRead.collection.findFirstOrThrow.mockRejectedValue(notFound);
    mockDbWrite.collection.findFirstOrThrow.mockRejectedValue(notFound);

    await expect(
      deleteCollectionById({ id: COLLECTION_ID, userId: CREATOR_USER_ID })
    ).rejects.toThrow();
    expect(mockDbWrite.collection.delete).not.toHaveBeenCalled();
  });

  it('detaches entrant posts before dropping the collection', async () => {
    // The generic path every contest collection is actually deleted through; `deleteChallenge` is
    // the narrow one.
    mockDbRead.collection.findFirstOrThrow.mockResolvedValue({ id: COLLECTION_ID, mode: 'Contest' });

    await deleteCollectionById({ id: COLLECTION_ID, userId: JUDGE_USER_ID, isModerator: true });

    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toMatch(
      /UPDATE "Post" SET "collectionId" = NULL\s+WHERE id IN \(\s*SELECT id FROM "Post" WHERE "collectionId" = \?/
    );
    expect(values[0]).toBe(COLLECTION_ID);
    expect(mockDbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.collection.delete.mock.invocationCallOrder[0]
    );
  });

  it('rejects the creator editing collection settings', async () => {
    await expect(
      upsertCollection({
        input: { id: COLLECTION_ID, userId: CREATOR_USER_ID, name: 'Renamed' } as never,
      })
    ).rejects.toThrow(/permission/i);
  });

  // removeCollectionItem is deliberately not covered here: its guard is satisfied by
  // permissions.writeReview, which every authenticated user gets on a write: Review collection,
  // so ownership never gated it — this change doesn't touch that exposure (tracked separately).
});
