import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CollectionItemRejectionReason, CollectionItemStatus } from '~/shared/utils/prisma/enums';

const createNotificationMock = vi.fn();
vi.mock('~/server/services/notification.service', () => ({
  createNotification: createNotificationMock,
}));

const mockDbWrite = dbMock.dbWrite;

const COLLECTION_ID = 10;
const ITEM_ID = 77;
const REVIEWER_ID = 5;
const SUBMITTER_ID = 42;

// The service is imported dynamically, after the mock above is registered.
// Do NOT add a direct mock of the db client module — `dbMock` is registered globally in
// `src/__tests__/setup.ts` (the canonical mock) and a local mock of that module conflicts with it.
const { updateCollectionItemsStatus } = await import('~/server/services/collection.service');

function mockContestCollection() {
  mockDbWrite.collection.findUnique.mockResolvedValue({
    id: COLLECTION_ID,
    type: 'Image',
    mode: 'Contest',
    name: 'Test Contest',
    metadata: {},
  });
}

function mockPriorItem(status: CollectionItemStatus = CollectionItemStatus.REVIEW) {
  mockDbWrite.collectionItem.findMany.mockResolvedValue([
    {
      id: ITEM_ID,
      addedById: SUBMITTER_ID,
      status,
      imageId: 1234,
      articleId: null,
      modelId: null,
      postId: null,
    },
  ]);
}

// The bulk UPDATE binds, in order: reviewedById, reviewedAt, updatedAt, status,
// rejectionReason, rejectionDetail, collectionId, ...itemIds.
function rejectionBindings() {
  const [, ...values] = mockDbWrite.$executeRaw.mock.calls[0];
  return { reason: values[4], detail: values[5] };
}

describe('updateCollectionItemsStatus rejection reasons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContestCollection();
    mockPriorItem();
  });

  it('persists the reason on a rejection', async () => {
    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
        rejectionReason: CollectionItemRejectionReason.Duplicate,
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    expect(rejectionBindings()).toEqual({
      reason: CollectionItemRejectionReason.Duplicate,
      detail: null,
    });
  });

  it('persists the free text for Other', async () => {
    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
        rejectionReason: CollectionItemRejectionReason.Other,
        rejectionDetail: 'Crop out the watermark.',
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    expect(rejectionBindings()).toEqual({
      reason: CollectionItemRejectionReason.Other,
      detail: 'Crop out the watermark.',
    });
  });

  // Without this, an item rejected and later accepted keeps a stale reason that the
  // read-back UI would happily show next to an ACCEPTED badge.
  it('clears the reason when the item is accepted', async () => {
    mockPriorItem(CollectionItemStatus.REJECTED);

    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.ACCEPTED,
        rejectionReason: CollectionItemRejectionReason.Duplicate,
        rejectionDetail: 'ignored on an acceptance',
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    expect(rejectionBindings()).toEqual({ reason: null, detail: null });
  });

  it('sends the canned copy to the submitter', async () => {
    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
        rejectionReason: CollectionItemRejectionReason.OffTopic,
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const [{ type, userId, details }] = createNotificationMock.mock.calls[0];
    expect(type).toBe('collection-item-rejected');
    expect(userId).toBe(SUBMITTER_ID);
    expect(details.reason).toBe("It doesn't fit this collection's theme.");
  });

  it("sends the reviewer's own words for Other", async () => {
    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
        rejectionReason: CollectionItemRejectionReason.Other,
        rejectionDetail: 'Crop out the watermark.',
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    const [{ details }] = createNotificationMock.mock.calls[0];
    expect(details.reason).toBe('Crop out the watermark.');
  });

  it('leaves the reason undefined when none was given', async () => {
    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    const [{ details }] = createNotificationMock.mock.calls[0];
    expect(details.reason).toBeUndefined();
  });

  // The AI reviewer's path: it hands over a fully resolved sentence (including any
  // per-collection reasonCopy override) and files it under Automated. The submitter
  // must still read exactly that sentence, and it must now also be on the row.
  it("records the AI reviewer's rejection under Automated", async () => {
    await updateCollectionItemsStatus({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
        rejectionReason: CollectionItemRejectionReason.Automated,
        rejectionDetail: 'This collection needs to stay PG-13.',
      },
      userId: REVIEWER_ID,
      isSystem: true,
    });

    expect(rejectionBindings()).toEqual({
      reason: CollectionItemRejectionReason.Automated,
      detail: 'This collection needs to stay PG-13.',
    });
    const [{ details }] = createNotificationMock.mock.calls[0];
    expect(details.reason).toBe('This collection needs to stay PG-13.');
  });
});
