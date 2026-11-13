import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { throwBadRequestError } from '~/server/utils/errorHandling';

const entityFields = ['imageId', 'modelId', 'articleId', 'postId', 'model3dId'] as const;

export class CollectionSubmissionLimitError extends TRPCError {
  constructor() {
    super({
      code: 'BAD_REQUEST',
      message: 'You have reached the maximum number of items in collection',
    });
  }
}

type LimitedCollection = {
  id: number;
  metadata: { maxItemsPerUser?: number } | null;
};

export async function withCollectionSubmissionLimits<T>(
  {
    collections,
    items,
    userId,
    isModerator,
  }: {
    collections: LimitedCollection[];
    items: Prisma.CollectionItemCreateManyInput[];
    userId: number;
    isModerator?: boolean;
  },
  write: (tx: Prisma.TransactionClient) => Promise<T>
) {
  const limited = isModerator
    ? []
    : collections.filter((c) => c.metadata?.maxItemsPerUser).sort((a, b) => a.id - b.id);
  if (!limited.length) return write(dbWrite);

  return dbWrite.$transaction(async (tx) => {
    for (const collection of limited) {
      const maximum = collection.metadata?.maxItemsPerUser;
      if (!maximum) continue;
      const incoming = items.filter(
        (item) =>
          item.collectionId === collection.id &&
          (item.status === CollectionItemStatus.ACCEPTED ||
            item.status === CollectionItemStatus.REVIEW)
      );
      if (!incoming.length) continue;

      // The same lock covers single-item and bulk writes, until their transaction commits.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`collection-submission-limit:${collection.id}:${userId}`}, 0))`;

      const requested = incoming.map((item) => {
        const field = entityFields.find((field) => item[field] != null);
        if (!field) throw throwBadRequestError('Collection entry has no entity');
        return { [field]: item[field] };
      });
      const existing = await tx.collectionItem.findMany({
        where: { collectionId: collection.id, OR: requested },
        select: { imageId: true, modelId: true, articleId: true, postId: true, model3dId: true },
      });
      const identity = (item: Partial<Record<(typeof entityFields)[number], number | null>>) =>
        entityFields
          .filter((field) => item[field] != null)
          .map((field) => `${field}:${item[field]}`)
          .join(',');
      const existingKeys = new Set(existing.map(identity));
      const newKeys = new Set(requested.map(identity).filter((key) => !existingKeys.has(key)));
      if (!newKeys.size) continue;

      const activeCount = await tx.collectionItem.count({
        where: {
          collectionId: collection.id,
          addedById: userId,
          status: { in: [CollectionItemStatus.ACCEPTED, CollectionItemStatus.REVIEW] },
        },
      });
      if (activeCount + newKeys.size > maximum) {
        throw new CollectionSubmissionLimitError();
      }
    }

    return write(tx);
  });
}
