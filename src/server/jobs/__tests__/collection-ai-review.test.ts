import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionReviewService from '~/server/services/ai/collection-review.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as TrackerModule from '~/server/clickhouse/tracker';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { CollectionItemRejectionReason, CollectionItemStatus } from '~/shared/utils/prisma/enums';
import type { CollectionAiReviewSchema } from '~/server/schema/collection.schema';
import { DEFAULT_AI_REVIEW_REASON_COPY } from '~/server/services/ai/collection-review.service';
import {
  MAX_REVIEW_ATTEMPTS,
  UNAVAILABLE_IMAGE_REJECTION,
  recordFailedAttempt,
  resolveAutomatedRejectionReason,
  reviewCollection,
} from '~/server/jobs/collection-ai-review';

const { reviewImage, updateCollectionItemsStatus } = vi.hoisted(() => ({
  reviewImage: vi.fn(),
  updateCollectionItemsStatus: vi.fn(),
}));

vi.mock('~/server/services/ai/collection-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionReviewService>()),
  reviewImage,
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  updateCollectionItemsStatus,
}));

vi.mock('~/server/clickhouse/tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackerModule>()),
  Tracker: class {
    collectionAiReview = vi.fn();
  },
}));

vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: () => 'https://image.example/x.jpeg',
}));

const COLLECTION_ID = 42;
const ITEM_ID = 1001;

const config: CollectionAiReviewSchema = {
  enabled: true,
  model: 'xiaomi/mimo-v2.5',
  prompt: 'review',
  allowedNsfwLevels: 3,
  escalationAction: 'reject',
  dryRun: false,
};

function pendingItem(overrides: Record<string, unknown> = {}) {
  return {
    collectionItemId: ITEM_ID,
    imageId: 5,
    url: 'abc',
    type: 'image',
    nsfwLevel: 1,
    ingestion: 'Scanned',
    prompt: null,
    ...overrides,
  };
}

const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');
const claimCalls = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.filter((call: unknown[]) =>
    sqlOf(call).includes('SET "reviewedById"')
  );

function queuePending(...items: ReturnType<typeof pendingItem>[]) {
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: string[]) => {
    const sql = strings.join('?');
    if (sql.includes('SET "reviewedById"')) return items.map((i) => ({ id: i.collectionItemId }));
    return items;
  });
}

beforeEach(() => {
  reviewImage.mockReset();
  updateCollectionItemsStatus.mockReset();
  dbMock.dbWrite.$queryRaw.mockClear();
  redisMock.sysRedis.incrBy.mockReset();
  redisMock.sysRedis.expire.mockClear();
});

describe('reviewCollection: a failed model call', () => {
  it.each([1, MAX_REVIEW_ATTEMPTS - 1])(
    'leaves the item unclaimed for a later run after failed attempt %i',
    async (attempts) => {
      queuePending(pendingItem());
      reviewImage.mockRejectedValue(new Error('Response validation failed'));
      redisMock.sysRedis.incrBy.mockResolvedValue(attempts);

      await reviewCollection(COLLECTION_ID, config);

      expect(reviewImage).toHaveBeenCalledTimes(1);
      expect(claimCalls()).toHaveLength(0);
    }
  );

  it('stamps the item for a human once the attempts run out', async () => {
    queuePending(pendingItem());
    reviewImage.mockRejectedValue(new Error('Response validation failed'));
    redisMock.sysRedis.incrBy.mockResolvedValue(MAX_REVIEW_ATTEMPTS);

    await reviewCollection(COLLECTION_ID, config);

    expect(claimCalls()).toHaveLength(1);
    expect(updateCollectionItemsStatus).not.toHaveBeenCalled();
    // Per collection item, not per image: one image submitted to two collections gets two budgets.
    expect(redisMock.sysRedis.incrBy).toHaveBeenCalledTimes(1);
    expect(redisMock.sysRedis.incrBy).toHaveBeenCalledWith(
      `system:collection-ai-review:attempts:${ITEM_ID}`,
      1
    );
  });
});

describe('recordFailedAttempt', () => {
  it('counts per item and keeps the count for a week', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValue(2);

    await expect(recordFailedAttempt(ITEM_ID)).resolves.toBe(2);
    expect(redisMock.sysRedis.incrBy).toHaveBeenCalledWith(
      `system:collection-ai-review:attempts:${ITEM_ID}`,
      1
    );
    // Must outlive the 15-minute gap between runs, or the count never reaches the cap.
    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(
      `system:collection-ai-review:attempts:${ITEM_ID}`,
      7 * 24 * 60 * 60
    );
  });

  // Failing open here would retry, and re-bill, a broken item on every run while Redis is down.
  it('reads a Redis failure as out of attempts', async () => {
    redisMock.sysRedis.incrBy.mockRejectedValue(new Error('redis down'));

    await expect(recordFailedAttempt(ITEM_ID)).resolves.toBe(MAX_REVIEW_ATTEMPTS);
  });

  it('reads a failure to set the expiry as out of attempts', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValue(1);
    redisMock.sysRedis.expire.mockRejectedValueOnce(new Error('redis down'));

    await expect(recordFailedAttempt(ITEM_ID)).resolves.toBe(MAX_REVIEW_ATTEMPTS);
  });
});

describe('reviewCollection: an image rated outside the allowed levels', () => {
  it('is rejected with the collection copy, not the unavailable-image copy', async () => {
    queuePending(pendingItem({ nsfwLevel: 4 }));

    await reviewCollection(COLLECTION_ID, config);

    expect(reviewImage).not.toHaveBeenCalled();
    expect(updateCollectionItemsStatus).toHaveBeenCalledTimes(1);
    expect(updateCollectionItemsStatus.mock.calls[0][0].rejectionDetail).toBe(
      DEFAULT_AI_REVIEW_REASON_COPY['sexual/adult content']
    );
  });
});

describe('reviewCollection: an image the scanner could not find', () => {
  it('rejects it with its own reason instead of waiting for a rating that never comes', async () => {
    queuePending(pendingItem({ nsfwLevel: 0, ingestion: 'NotFound' }));

    await reviewCollection(COLLECTION_ID, config);

    expect(reviewImage).not.toHaveBeenCalled();
    expect(updateCollectionItemsStatus).toHaveBeenCalledTimes(1);
    expect(updateCollectionItemsStatus.mock.calls[0][0]).toMatchObject({
      input: {
        collectionId: COLLECTION_ID,
        collectionItemIds: [ITEM_ID],
        status: CollectionItemStatus.REJECTED,
        rejectionReason: CollectionItemRejectionReason.Automated,
      },
      rejectionDetail: UNAVAILABLE_IMAGE_REJECTION,
    });
  });

  it('only stamps it in a dry run', async () => {
    queuePending(pendingItem({ nsfwLevel: 0, ingestion: 'NotFound' }));

    await reviewCollection(COLLECTION_ID, { ...config, dryRun: true });

    expect(claimCalls()).toHaveLength(1);
    expect(updateCollectionItemsStatus).not.toHaveBeenCalled();
  });

  it('still skips an image that is merely not rated yet', async () => {
    queuePending(pendingItem({ nsfwLevel: 0, ingestion: 'Pending' }));

    await reviewCollection(COLLECTION_ID, config);

    expect(reviewImage).not.toHaveBeenCalled();
    expect(claimCalls()).toHaveLength(0);
  });
});

describe('resolveAutomatedRejectionReason', () => {
  it('files an AI rejection under Automated', () => {
    expect(resolveAutomatedRejectionReason({ status: CollectionItemStatus.REJECTED })).toBe(
      CollectionItemRejectionReason.Automated
    );
  });

  it('leaves an acceptance with no reason', () => {
    expect(
      resolveAutomatedRejectionReason({ status: CollectionItemStatus.ACCEPTED })
    ).toBeUndefined();
  });
});
