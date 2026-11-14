import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { AI_REVIEW_MODELS, collectionAiReviewSchema } from '~/server/schema/collection.schema';
import { setCollectionAiReview } from '~/server/services/collection.service';

const collectionId = 10;
const aiReview = collectionAiReviewSchema.parse({
  enabled: true,
  model: AI_REVIEW_MODELS[0],
  prompt: 'Accept images that follow the board rules.',
});

describe('collection AI review settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([null, CollectionMode.Contest])(
    'enables review with collection mode %s',
    async (mode) => {
      dbMock.dbRead.collection.findUnique.mockResolvedValue({ id: collectionId, mode });

      await setCollectionAiReview({ collectionId, aiReview });

      expect(dbMock.dbWrite.keyValue.upsert).toHaveBeenCalledWith({
        where: { key: `collection-ai-review:${collectionId}` },
        create: { key: `collection-ai-review:${collectionId}`, value: aiReview },
        update: { value: aiReview },
      });
    }
  );

  it('refuses to configure a missing collection', async () => {
    dbMock.dbRead.collection.findUnique.mockResolvedValue(null);

    await expect(setCollectionAiReview({ collectionId, aiReview })).rejects.toThrow(
      'No collection with id ' + collectionId
    );
    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });
});
