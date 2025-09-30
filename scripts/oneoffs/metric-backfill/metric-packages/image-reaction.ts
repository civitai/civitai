import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type ImageReactionRow = {
  imageId: number;
  userId: number;
  reaction: string;
  createdAt: Date;
  imageOwnerId: number;
  postId: number | null;
};

export const imageReactionPackage: MigrationPackage<ImageReactionRow> = {
  queryBatchSize: 5000,
  range: createIdRangeFetcher('ImageReaction', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<ImageReactionRow>(
      `SELECT ir."imageId", ir."userId", ir."reaction", ir."createdAt",
              i."userId" as "imageOwnerId", i."postId"
       FROM "ImageReaction" ir
       JOIN "Image" i ON i.id = ir."imageId"
       WHERE ir."createdAt" < $1
         AND ir.id >= $2
         AND ir.id <= $3
       ORDER BY ir.id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((reaction) => {
      // User reactionCount (content owner gets credit)
      addMetrics({
        entityType: 'User',
        entityId: reaction.imageOwnerId,
        userId: reaction.userId,
        metricType: 'reactionCount',
        metricValue: 1,
        createdAt: reaction.createdAt,
      });

      // Image-specific reaction metrics (Like, Heart, etc.)
      addMetrics({
        entityType: 'Image',
        entityId: reaction.imageId,
        userId: reaction.userId,
        metricType: reaction.reaction,
        metricValue: 1,
        createdAt: reaction.createdAt,
      });

      // Post-specific reaction metrics (if image belongs to a post)
      if (reaction.postId) {
        addMetrics(
          {
            entityType: 'Post',
            entityId: reaction.postId,
            userId: reaction.userId,
            metricType: reaction.reaction,
            metricValue: 1,
            createdAt: reaction.createdAt,
          },
          {
            entityType: 'Post',
            entityId: reaction.postId,
            userId: reaction.userId,
            metricType: 'reactionCount',
            metricValue: 1,
            createdAt: reaction.createdAt,
          }
        );
      }
    });
  },
};
