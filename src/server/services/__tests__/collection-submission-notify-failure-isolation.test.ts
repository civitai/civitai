import { beforeEach, describe, expect, it, vi } from 'vitest';

// Failure isolation for the submission-notification fan-out in `saveItemInCollections`
// (collection.service.ts): by the time recipients are resolved, `dbWrite.$transaction`
// has already committed the item write. A failure resolving/notifying recipients (e.g. a
// replica hiccup on the `CollectionContributor` lookup) must never propagate out of
// `saveItemInCollections` — the caller would see an error for a submit that actually
// succeeded, and likely retry and double-submit.

const {
  mockDbRead,
  mockDbWrite,
  mockCreateNotification,
  mockHomeBlockCacheBust,
  mockQueueUpdate,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockDbRead: {
    collection: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    collectionContributor: { findMany: vi.fn() },
  },
  mockDbWrite: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  mockCreateNotification: vi.fn(),
  mockHomeBlockCacheBust: vi.fn(),
  mockQueueUpdate: vi.fn(),
  mockLogToAxiom: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
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

const { saveItemInCollections } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const MANAGER_ID = 777;
const SUBMITTER_ID = 555;
const IMAGE_ID = 42;

// `getUserCollectionPermissionsByIds` grants ADD_REVIEW to the submitter via a
// contributor row (rather than the free write:Review grant alone) so `isContributor`
// is true — that skips the `addContributorToCollection` follow-on-submit branch, which
// isn't what this test is about.
function arrangeReviewCollection() {
  mockDbRead.collection.findMany.mockResolvedValue([
    {
      id: COLLECTION_ID,
      name: 'Test Collection',
      description: null,
      read: 'Public',
      write: 'Review',
      type: null,
      nsfw: false,
      nsfwLevel: 0,
      image: null,
      mode: null,
      metadata: {},
      availability: 'Public',
      userId: OWNER_ID,
      tags: [],
    },
  ]);
  mockDbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: 'Public',
      write: 'Review',
      userId: OWNER_ID,
      type: null,
      mode: null,
      contributorPermissions: ['ADD_REVIEW'],
      collaborationDisabledAt: null,
    },
  ]);
}

function submit() {
  return saveItemInCollections({
    input: {
      collections: [{ collectionId: COLLECTION_ID }],
      imageId: IMAGE_ID,
      userId: SUBMITTER_ID,
      isModerator: false,
    } as never,
  });
}

describe('saveItemInCollections — submission-notify failure isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.$transaction.mockResolvedValue(undefined);
    arrangeReviewCollection();
  });

  it('still reports the item as added when resolving recipients throws', async () => {
    mockDbRead.collectionContributor.findMany.mockRejectedValue(new Error('replica hiccup'));

    await expect(submit()).resolves.toBe('added');

    expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1); // item write already committed
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'collection-submission-notify-failed' })
    );
  });

  it('notifies the owner and MANAGE holders, excluding the submitter, on the happy path', async () => {
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { collectionId: COLLECTION_ID, userId: MANAGER_ID },
    ]);

    await expect(submit()).resolves.toBe('added');

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collection-submission-received',
        userIds: expect.arrayContaining([OWNER_ID, MANAGER_ID]),
      })
    );
    const call = mockCreateNotification.mock.calls[0][0] as { userIds: number[] };
    expect(call.userIds).not.toContain(SUBMITTER_ID);
  });
});
