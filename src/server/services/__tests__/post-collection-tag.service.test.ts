import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CollectionService from '~/server/services/collection.service';
import { CONTEST_BANNED_MESSAGE } from '~/shared/constants/contest-ban.constants';

// A post's entry category in a contest collection, changed from the post editor.

const { getCollectionById, permissions, isContestBanned } = vi.hoisted(() => ({
  getCollectionById: vi.fn(),
  permissions: vi.fn(),
  isContestBanned: vi.fn(),
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById,
  getUserCollectionPermissionsById: permissions,
}));
vi.mock('~/server/services/contest-ban', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isContestBanned,
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));

const { updatePostCollectionTagId } = await import('~/server/services/post.service');

const POST_ID = 1;
const COLLECTION_ID = 5;
const CATEGORY_A = 10;
const CATEGORY_B = 11;
const SYSTEM_TAG = 99;
const OWNER = 7;
const MANAGER = 8;
const past = () => new Date(Date.now() - 86_400_000).toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.post.findUnique.mockResolvedValue({
    collectionId: COLLECTION_ID,
    userId: 7,
  } as never);
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 40 }, { id: 41 }] as never);
  dbMock.dbWrite.collectionItem.updateMany.mockResolvedValue({ count: 2 } as never);
  permissions.mockImplementation(async ({ userId }: { userId: number }) => ({
    manage: userId === MANAGER,
  }));
  isContestBanned.mockResolvedValue(false);
  // The shape getCollectionById returns: each tag flattened to { id, name, filterableOnly }.
  getCollectionById.mockResolvedValue({
    id: COLLECTION_ID,
    mode: 'Contest',
    type: 'Image',
    metadata: { submissionEndDate: future() },
    tags: [
      { id: CATEGORY_A, name: 'A', filterableOnly: false },
      { id: CATEGORY_B, name: 'B', filterableOnly: false },
      { id: SYSTEM_TAG, name: 'Judged', filterableOnly: true },
    ],
  });
});

const change = (collectionTagId: number, userId = OWNER) =>
  updatePostCollectionTagId({ id: POST_ID, collectionTagId, userId });

describe("changing a contest post's entry category", () => {
  it("moves the post's entries to another category", async () => {
    await change(CATEGORY_B);
    expect(dbMock.dbWrite.collectionItem.updateMany).toHaveBeenCalledOnce();
    expect(dbMock.dbWrite.collectionItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { collectionId: COLLECTION_ID, imageId: { in: [40, 41] } },
      data: { tagId: CATEGORY_B },
    });
  });

  it('leaves entries that carry a tag other than a category alone', async () => {
    await change(CATEGORY_B);
    expect(dbMock.dbWrite.collectionItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { OR: [{ tagId: null }, { tagId: { in: [CATEGORY_A, CATEGORY_B] } }] },
    });
  });

  it.each([
    ['a tag the collection only filters by', SYSTEM_TAG],
    ['a tag the collection does not have', 12345],
  ])('refuses %s', async (_, tagId) => {
    await expect(change(tagId)).rejects.toMatchObject({ message: 'Invalid tag' });
    expect(dbMock.dbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('when submissions are closed', () => {
  beforeEach(async () => {
    const open = await getCollectionById();
    getCollectionById.mockResolvedValue({ ...open, metadata: { submissionEndDate: past() } });
  });

  it("refuses the entrant's change", async () => {
    await expect(change(CATEGORY_B)).rejects.toMatchObject({
      message: 'Submissions for this contest are closed',
    });
    expect(dbMock.dbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
  });

  it("lets the collection's manager change it (control)", async () => {
    await change(CATEGORY_B, MANAGER);
    expect(dbMock.dbWrite.collectionItem.updateMany).toHaveBeenCalledOnce();
  });
});

it('refuses a change from an entrant barred from contests', async () => {
  isContestBanned.mockResolvedValue(true);
  await expect(change(CATEGORY_B)).rejects.toMatchObject({ message: CONTEST_BANNED_MESSAGE });
  expect(dbMock.dbWrite.collectionItem.updateMany).not.toHaveBeenCalled();
});
