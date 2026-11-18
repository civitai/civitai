import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageVisibility from '~/server/services/image-visibility.service';
import type * as ChallengeFunding from '~/server/games/daily-challenge/challenge-funding';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `bulkSaveItems` is the wider of the two submit paths (collection "Submit an entry", direct
// upload, post-publish-into-a-collection) and notified nobody — ClickUp 868m15nne.

const { mockCreateNotification, mockHomeBlockCacheBust, mockQueueUpdate, mockChargeEntryFees } =
  vi.hoisted(() => ({
    mockCreateNotification: vi.fn(),
    mockHomeBlockCacheBust: vi.fn(),
    mockQueueUpdate: vi.fn(),
    mockChargeEntryFees: vi.fn(),
  }));

vi.mock('~/server/games/daily-challenge/challenge-funding', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeFunding>()),
  chargeEntryFees: mockChargeEntryFees,
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/home-block-cache.service', () => ({
  homeBlockCacheBust: mockHomeBlockCacheBust,
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockQueueUpdate },
}));

// Every image here is one the submitter may see; the visibility rule has its own test.
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibility>()),
  assertImagesVisibleToViewer: vi.fn(async () => undefined),
}));

const { bulkSaveItems, saveItemInCollections } = await import(
  '~/server/services/collection.service'
);

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const MANAGER_ID = 777;
const SUBMITTER_ID = 555;
const JUDGE_USER_ID = 6235605;
const IMAGE_IDS = [42, 43, 44];

function arrangeCollection(overrides: Record<string, unknown> = {}) {
  mockDbRead.collection.findUnique.mockResolvedValue({
    id: COLLECTION_ID,
    name: 'Indie Spotlight',
    description: null,
    read: 'Public',
    write: 'Review',
    type: 'Image',
    nsfw: false,
    nsfwLevel: 0,
    image: null,
    mode: null,
    metadata: {},
    availability: 'Public',
    userId: OWNER_ID,
    tags: [],
    ...overrides,
  });
}

// `isContributor` short-circuits the follow-on-submit branch, which isn't what these tests are about.
// `writeReview` without `manage`/`isOwner`/`isCollaborator` is what puts the write into REVIEW.
function reviewPermissions() {
  return {
    collectionId: COLLECTION_ID,
    read: true,
    write: false,
    writeReview: true,
    manage: false,
    follow: true,
    isContributor: true,
    isOwner: false,
    isCollaborator: false,
  } as never;
}

function submit(permissions = reviewPermissions()) {
  return bulkSaveItems({
    input: {
      collectionId: COLLECTION_ID,
      imageIds: IMAGE_IDS,
      userId: SUBMITTER_ID,
      isModerator: false,
    } as never,
    permissions,
  });
}

function mixedSave(contestIds: number[]) {
  const targets = [
    { id: COLLECTION_ID, mode: null, metadata: { maxItemsPerUser: 2 } },
    ...contestIds.map((id) => ({ id, mode: 'Contest', metadata: {} })),
  ].map((c) => ({
    ...c,
    userId: SUBMITTER_ID,
    name: 'Collection',
    type: 'Image',
    tags: [],
    read: 'Public',
    write: 'Private',
  }));
  mockDbRead.collection.findMany.mockResolvedValue(targets);
  mockDbRead.user.findUnique.mockResolvedValue({ id: SUBMITTER_ID, meta: {} });
  mockDbRead.$queryRaw.mockResolvedValue(targets);
  mockDbWrite.challenge.findFirst.mockImplementation(
    async ({ where }: { where: { collectionId: number; source?: string } }) =>
      where.source === 'User'
        ? {
            id: where.collectionId + 100,
            createdById: OWNER_ID,
            status: 'Active',
            entryFee: 10,
            buzzType: 'yellow',
          }
        : null
  );
  return saveItemInCollections({
    input: {
      imageId: 42,
      userId: SUBMITTER_ID,
      canAccessUserChallenges: true,
      collections: targets.map((c) => ({ collectionId: c.id })),
      removeFromCollectionIds: [],
    },
  });
}

describe('bulkSaveItems — submission notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeCollection();
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    mockDbWrite.collectionItem.createMany.mockResolvedValue({ count: IMAGE_IDS.length });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.challengeJudge.findMany.mockResolvedValue([]);
    mockDbWrite.collectionItem.findMany.mockResolvedValue([]);
    mockDbWrite.collectionItem.count.mockResolvedValue(0);
    mockDbWrite.collectionItem.deleteMany.mockResolvedValue({ count: 1 });
    mockDbWrite.challenge.findFirst.mockResolvedValue(null);
    mockChargeEntryFees.mockResolvedValue({ paidImageIds: [42], unpaidImageIds: [] });
  });

  it('charges the contest fee after a successful mixed save', async () => {
    await expect(mixedSave([20])).resolves.toBe('added');
    expect(mockChargeEntryFees).toHaveBeenCalledTimes(1);
    expect(mockChargeEntryFees).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 120, imageIds: [42] })
    );
  });

  it('settles every contest when one deferred fee fails and rolls back its unpaid entry', async () => {
    mockChargeEntryFees.mockImplementation(async ({ challengeId }: { challengeId: number }) => ({
      paidImageIds: challengeId === 120 ? [] : [42],
      unpaidImageIds: challengeId === 120 ? [42] : [],
    }));
    await expect(mixedSave([20, 30])).rejects.toThrow('enough Buzz');
    expect(mockChargeEntryFees).toHaveBeenCalledTimes(2);
    expect(mockChargeEntryFees.mock.calls.map(([input]) => input.challengeId)).toEqual([120, 130]);
    expect(mockDbWrite.collectionItem.deleteMany).toHaveBeenCalledWith({
      where: { collectionId: 20, addedById: SUBMITTER_ID, imageId: { in: [42] } },
    });
  });

  it('refuses a third pending entry in a normal collection without writing it', async () => {
    arrangeCollection({ metadata: { maxItemsPerUser: 2 } });
    mockDbWrite.collectionItem.count.mockResolvedValue(2);
    await expect(
      bulkSaveItems({
        input: { collectionId: COLLECTION_ID, imageIds: [42], userId: SUBMITTER_ID },
        permissions: reviewPermissions(),
      })
    ).rejects.toThrow('maximum number');
    expect(mockDbWrite.collectionItem.createMany).not.toHaveBeenCalled();
  });

  it('does not charge a contest fee when a mixed save exceeds a normal collection quota', async () => {
    const targets = [
      { id: COLLECTION_ID, mode: null, metadata: { maxItemsPerUser: 2 } },
      { id: 20, mode: 'Contest', metadata: {} },
    ].map((c) => ({
      ...c,
      userId: SUBMITTER_ID,
      name: 'Collection',
      type: 'Image',
      tags: [],
      read: 'Public',
      write: 'Private',
    }));
    mockDbRead.collection.findMany.mockResolvedValue(targets);
    mockDbRead.user.findUnique.mockResolvedValue({ id: SUBMITTER_ID, meta: {} });
    mockDbRead.$queryRaw.mockResolvedValue(targets);
    mockDbWrite.collectionItem.count.mockResolvedValue(2);
    mockDbWrite.challenge.findFirst.mockImplementation(
      async ({ where }: { where: { source?: string } }) =>
        where.source === 'User'
          ? { id: 99, createdById: OWNER_ID, status: 'Active', entryFee: 10, buzzType: 'yellow' }
          : null
    );
    try {
      await expect(
        saveItemInCollections({
          input: {
            imageId: 42,
            userId: SUBMITTER_ID,
            canAccessUserChallenges: true,
            collections: targets.map((c) => ({ collectionId: c.id })),
            removeFromCollectionIds: [],
          },
        })
      ).rejects.toThrow('maximum number');
      expect(mockChargeEntryFees).not.toHaveBeenCalled();
    } finally {
      mockDbWrite.challenge.findFirst.mockReset();
    }
  });

  it('accepts two distinct entries when a bulk request repeats an image', async () => {
    arrangeCollection({ metadata: { maxItemsPerUser: 2 } });
    await bulkSaveItems({
      input: { collectionId: COLLECTION_ID, imageIds: [42, 42, 43], userId: SUBMITTER_ID },
      permissions: reviewPermissions(),
    });
    expect(mockDbWrite.collectionItem.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ imageId: 42 }), expect.objectContaining({ imageId: 43 })],
    });
  });

  it('notifies the owner and MANAGE holders once for the whole batch', async () => {
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { collectionId: COLLECTION_ID, userId: MANAGER_ID },
    ]);

    await submit();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collection-submission-received',
        userIds: expect.arrayContaining([OWNER_ID, MANAGER_ID]),
        details: { collectionId: COLLECTION_ID, collectionName: 'Indie Spotlight' },
      })
    );
    const { userIds } = mockCreateNotification.mock.calls[0][0] as { userIds: number[] };
    expect(userIds).not.toContain(SUBMITTER_ID);
  });

  it('does not notify when the entries were accepted outright rather than queued for review', async () => {
    await submit({ ...reviewPermissions(), writeReview: true, manage: true } as never);

    expect(mockDbWrite.collectionItem.createMany).toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does not notify when every item was already in the collection', async () => {
    mockDbRead.collectionItem.findMany.mockResolvedValue(IMAGE_IDS.map((imageId) => ({ imageId })));
    mockDbWrite.collectionItem.createMany.mockResolvedValue({ count: 0 });

    await submit();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('drops a challenge judge from the recipients, leaving nothing to send', async () => {
    arrangeCollection({ userId: JUDGE_USER_ID, mode: null });
    mockDbRead.challengeJudge.findMany.mockResolvedValue([{ userId: JUDGE_USER_ID }]);

    await submit();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('still reports the saved items when notifying throws', async () => {
    mockDbRead.collectionContributor.findMany.mockRejectedValue(new Error('replica hiccup'));

    await expect(submit()).resolves.toEqual(
      expect.objectContaining({ count: IMAGE_IDS.length, imageIds: IMAGE_IDS })
    );
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
