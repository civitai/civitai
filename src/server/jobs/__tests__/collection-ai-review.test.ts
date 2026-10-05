import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionReviewService from '~/server/services/ai/collection-review.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as TrackerModule from '~/server/clickhouse/tracker';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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

const {
  reviewImage,
  updateCollectionItemsStatus,
  queueImageSearchIndexUpdate,
  bustCachesForPosts,
} = vi.hoisted(() => ({
  reviewImage: vi.fn(),
  updateCollectionItemsStatus: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
  bustCachesForPosts: vi.fn(),
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  bustCachesForPosts,
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate,
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
const minorFlagCalls = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.filter((call: unknown[]) =>
    sqlOf(call).includes(`SET "needsReview" = 'minor'`)
  );
const claimCalls = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.filter((call: unknown[]) =>
    sqlOf(call).includes('SET "reviewedById"')
  );

const postOf = (imageId: number) => imageId * 10;

function queuePending(
  items: ReturnType<typeof pendingItem>[],
  {
    flagImage,
  }: { flagImage?: (imageIds: number[]) => { id: number; postId: number | null }[] } = {}
) {
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: string[], ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('SET "reviewedById"')) return items.map((i) => ({ id: i.collectionItemId }));
    if (sql.includes('UPDATE "Image"')) {
      const imageIds = (values[0] as { values: number[] }).values;
      return flagImage ? flagImage(imageIds) : imageIds.map((id) => ({ id, postId: postOf(id) }));
    }
    return items;
  });
}

beforeEach(() => {
  reviewImage.mockReset();
  updateCollectionItemsStatus.mockReset();
  queueImageSearchIndexUpdate.mockReset().mockResolvedValue(undefined);
  bustCachesForPosts.mockReset().mockResolvedValue(undefined);
  loggingMock.logToAxiom.mockClear();
  dbMock.dbWrite.$queryRaw.mockClear();
  redisMock.sysRedis.incrBy.mockReset();
  redisMock.sysRedis.expire.mockClear();
});

describe('reviewCollection: a failed model call', () => {
  it.each([1, MAX_REVIEW_ATTEMPTS - 1])(
    'leaves the item unclaimed for a later run after failed attempt %i',
    async (attempts) => {
      queuePending([pendingItem()]);
      reviewImage.mockRejectedValue(new Error('Response validation failed'));
      redisMock.sysRedis.incrBy.mockResolvedValue(attempts);

      await reviewCollection(COLLECTION_ID, config);

      expect(reviewImage).toHaveBeenCalledTimes(1);
      expect(claimCalls()).toHaveLength(0);
    }
  );

  it('stamps the item for a human once the attempts run out', async () => {
    queuePending([pendingItem()]);
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
    queuePending([pendingItem({ nsfwLevel: 4 })]);

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
    queuePending([pendingItem({ nsfwLevel: 0, ingestion: 'NotFound' })]);

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
    queuePending([pendingItem({ nsfwLevel: 0, ingestion: 'NotFound' })]);

    await reviewCollection(COLLECTION_ID, { ...config, dryRun: true });

    expect(claimCalls()).toHaveLength(1);
    expect(updateCollectionItemsStatus).not.toHaveBeenCalled();
  });

  it('still skips an image that is merely not rated yet', async () => {
    queuePending([pendingItem({ nsfwLevel: 0, ingestion: 'Pending' })]);

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

const IMAGE_ID = 5;

const cleanObservations = {
  sexualContent: false,
  isPhotorealistic: false,
  suggestiveStyling: false,
  nsfwEstimate: 'PG',
  depictsMinor: false,
  minorIsPhotorealistic: false,
  minorInappropriate: false,
  depictsRealPerson: false,
  otherViolations: [],
  hasBuzzReference: true,
};

function modelSees(overrides: Record<string, unknown>) {
  reviewImage.mockResolvedValue({
    observations: { ...cleanObservations, ...overrides },
    usage: { promptTokens: 1, completionTokens: 1 },
  });
}

const statusWrites = () =>
  updateCollectionItemsStatus.mock.calls.map((call) => call[0].input.status as string);

// The Buzz Beggars Board runs with escalationAction 'reject' and deletes REJECTED items hourly, so
// before this the minor signal reached no human. The image queue is where it has to land.
describe('reviewCollection: a minor-related escalation', () => {
  it.each([
    ['photorealistic minor', { depictsMinor: true, minorIsPhotorealistic: true }, 'REJECTED'],
    [
      'minor depicted inappropriately',
      { depictsMinor: true, minorInappropriate: true },
      'REJECTED',
    ],
    // Our own uncertainty: never rejected, only stamped, and so still held for a person.
    ['possible minor', { minorUncertain: true, isPhotorealistic: true }, undefined],
  ])(
    'sends %s to the image minor queue whatever the collection does with it',
    async (_label, observations, collectionStatus) => {
      queuePending([pendingItem()]);
      modelSees(observations);

      await reviewCollection(COLLECTION_ID, config);

      const flags = minorFlagCalls();
      expect(flags).toHaveLength(1);
      expect((flags[0][1] as { values: number[] }).values).toEqual([IMAGE_ID]);
      expect(queueImageSearchIndexUpdate).toHaveBeenCalledTimes(1);
      expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({
        ids: [IMAGE_ID],
        action: 'Update',
      });
      // A held image must also leave the cached model-version showcase and post galleries.
      expect(bustCachesForPosts).toHaveBeenCalledWith([postOf(IMAGE_ID)]);
      expect(statusWrites()).toEqual(collectionStatus ? [collectionStatus] : []);
    }
  );

  it('flags the image even when escalations are configured to stamp', async () => {
    queuePending([pendingItem()]);
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, { ...config, escalationAction: 'stamp' });

    expect(minorFlagCalls()).toHaveLength(1);
    expect(statusWrites()).toEqual([]);
  });

  // F1 decision: never move an image out of another queue, not even newUser or tag, which minor
  // review outranks. A minor-queue accept resolves tag reviews the minor view never shows and can
  // clear the scanner's minor flag, so the move could lower the image. Decided with the
  // coordinator after review; widening this guard reopens that.
  it('only fills an empty slot on a scanned image, leaving every other queue alone', async () => {
    queuePending([pendingItem()]);
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, config);

    expect(sqlOf(minorFlagCalls()[0]).replace(/\s+/g, ' ').trim()).toBe(
      `UPDATE "Image" SET "needsReview" = 'minor', "updatedAt" = now() WHERE id IN (?) AND ("needsReview" IS NULL OR "needsReview" = 'minor') AND ingestion = 'Scanned' RETURNING id, "postId"`
    );
    // The image ids are the only bound value: no key list can reach the guard.
    expect(minorFlagCalls()[0]).toHaveLength(2);
  });

  it('leaves the image alone for an escalation that is not about a minor', async () => {
    queuePending([pendingItem()]);
    modelSees({ depictsRealPerson: true });

    await reviewCollection(COLLECTION_ID, config);

    expect(minorFlagCalls()).toHaveLength(0);
    expect(statusWrites()).toEqual(['REJECTED']);
  });

  it('writes nothing to the image in a dry run', async () => {
    queuePending([pendingItem()]);
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, { ...config, dryRun: true });

    expect(minorFlagCalls()).toHaveLength(0);
    expect(claimCalls()).toHaveLength(1);
  });

  // Rejecting it anyway would let the hourly sweep delete the only record of the signal.
  it('leaves the item unclaimed for a retry when the flag cannot be written', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValue(1);
    const other = pendingItem({ collectionItemId: ITEM_ID + 1, imageId: IMAGE_ID + 1 });
    queuePending([pendingItem(), other], {
      flagImage: () => {
        throw new Error('db down');
      },
    });
    modelSees({});
    reviewImage.mockResolvedValueOnce({
      observations: { ...cleanObservations, depictsMinor: true, minorIsPhotorealistic: true },
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(minorFlagCalls()).toHaveLength(1);
    const claims = claimCalls();
    expect(claims).toHaveLength(1);
    expect((claims[0][3] as { values: number[] }).values).toEqual([ITEM_ID + 1]);
    expect(statusWrites()).toEqual(['ACCEPTED']);
  });

  // A retry reclassifies from scratch, and a later verdict could approve what this one escalated.
  // Bounded like a failed model call, and then held rather than decided.
  it('stamps instead of rejecting once the flag write is out of attempts', async () => {
    redisMock.sysRedis.incrBy.mockResolvedValue(MAX_REVIEW_ATTEMPTS);
    const clean = pendingItem({ collectionItemId: ITEM_ID + 1, imageId: IMAGE_ID + 1 });
    queuePending([pendingItem(), clean], {
      flagImage: () => {
        throw new Error('db down');
      },
    });
    modelSees({});
    reviewImage.mockResolvedValueOnce({
      observations: { ...cleanObservations, depictsMinor: true, minorIsPhotorealistic: true },
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await reviewCollection(COLLECTION_ID, config);

    expect(claimCalls()).toHaveLength(1);
    expect((claimCalls()[0][3] as { values: number[] }).values).toEqual([ITEM_ID, ITEM_ID + 1]);
    // Only the clean item is decided; the escalated one stays in REVIEW.
    expect(updateCollectionItemsStatus.mock.calls.map((call) => call[0].input)).toEqual([
      expect.objectContaining({ collectionItemIds: [ITEM_ID + 1], status: 'ACCEPTED' }),
    ]);
  });

  // An image already held in another queue still gets a person; leaving the item unclaimed instead
  // would reselect and re-bill it every run, since nothing caps a successful model call.
  it('still decides the item when the image is already held elsewhere', async () => {
    queuePending([pendingItem()], { flagImage: () => [] });
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, config);

    expect(minorFlagCalls()).toHaveLength(1);
    expect((claimCalls()[0][3] as { values: number[] }).values).toEqual([ITEM_ID]);
    expect(statusWrites()).toEqual(['REJECTED']);
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(bustCachesForPosts).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
  });

  it('reindexes only the images the write actually flagged', async () => {
    const held = pendingItem({ collectionItemId: ITEM_ID + 1, imageId: IMAGE_ID + 1 });
    queuePending([pendingItem(), held], {
      flagImage: () => [{ id: IMAGE_ID, postId: postOf(IMAGE_ID) }],
    });
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, config);

    expect((minorFlagCalls()[0][1] as { values: number[] }).values).toEqual([
      IMAGE_ID,
      IMAGE_ID + 1,
    ]);
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledTimes(1);
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({ ids: [IMAGE_ID], action: 'Update' });
    expect(bustCachesForPosts).toHaveBeenCalledTimes(1);
    expect(bustCachesForPosts).toHaveBeenCalledWith([postOf(IMAGE_ID)]);
    // The unrouted one is the only trace outside ClickHouse.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Minor escalation not routed to the minor queue',
        imageIds: [IMAGE_ID + 1],
      })
    );
  });

  it('passes no post to the cache bust for an image with no post', async () => {
    queuePending([pendingItem()], { flagImage: () => [{ id: IMAGE_ID, postId: null }] });
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, config);

    expect(bustCachesForPosts).toHaveBeenCalledWith([]);
  });

  it('does not let a failed cache refresh undo the decision', async () => {
    queueImageSearchIndexUpdate.mockRejectedValue(new Error('redis down'));
    bustCachesForPosts.mockRejectedValue(new Error('redis down'));
    queuePending([pendingItem()]);
    modelSees({ depictsMinor: true, minorIsPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, config);

    expect(claimCalls()).toHaveLength(1);
    expect(statusWrites()).toEqual(['REJECTED']);
  });

  // A minor alongside another finding is the realistic case, with the minor not listed first.
  it('flags an image whose minor escalation comes after another one', async () => {
    queuePending([pendingItem()]);
    modelSees({ depictsRealPerson: true, minorUncertain: true, isPhotorealistic: true });

    await reviewCollection(COLLECTION_ID, config);

    expect(minorFlagCalls()).toHaveLength(1);
  });
});
