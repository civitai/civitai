import { describe, it, expect, vi, beforeEach } from 'vitest';

const JUDGE_USER_ID = 8_675_309;
const CREATOR_USER_ID = 42;
const COLLECTION_ID = 10;

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { collection: { findUnique: vi.fn() } },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

const { getUserCollectionPermissionsById, updateCollectionItemsStatus } = await import(
  '~/server/services/collection.service'
);

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
});
