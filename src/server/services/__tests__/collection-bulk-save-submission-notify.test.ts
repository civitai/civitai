import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `bulkSaveItems` is the wider of the two submit paths (collection "Submit an entry", direct
// upload, post-publish-into-a-collection) and notified nobody — ClickUp 868m15nne.

const { mockCreateNotification, mockHomeBlockCacheBust, mockQueueUpdate } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockHomeBlockCacheBust: vi.fn(),
  mockQueueUpdate: vi.fn(),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/home-block-cache.service', () => ({
  homeBlockCacheBust: mockHomeBlockCacheBust,
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockQueueUpdate },
  imagesSearchIndex: { queueUpdate: vi.fn() },
}));

const { bulkSaveItems } = await import('~/server/services/collection.service');

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

describe('bulkSaveItems — submission notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeCollection();
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
    mockDbWrite.collectionItem.createMany.mockResolvedValue({ count: IMAGE_IDS.length });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.challengeJudge.findMany.mockResolvedValue([]);
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
