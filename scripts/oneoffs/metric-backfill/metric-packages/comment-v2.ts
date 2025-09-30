import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type CommentRow = {
  postId: number | null;
  imageId: number | null;
  articleId: number | null;
  bountyId: number | null;
  userId: number;
  createdAt: Date;
};

export const commentV2Package: MigrationPackage<CommentRow> = {
  queryBatchSize: 5000,
  range: createIdRangeFetcher('CommentV2', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CommentRow>(
      `SELECT t."postId", t."imageId", t."articleId", t."bountyId",
              c."userId", c."createdAt"
       FROM "CommentV2" c
       JOIN "Thread" t ON c."threadId" = t.id
       WHERE c."createdAt" < $1
         AND c.id >= $2
         AND c.id <= $3
       ORDER BY c.id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((comment) => {
      if (comment.postId) {
        addMetrics({
          entityType: 'Post',
          entityId: comment.postId,
          userId: comment.userId,
          metricType: 'commentCount',
          metricValue: 1,
          createdAt: comment.createdAt,
        });
      }

      if (comment.imageId) {
        addMetrics({
          entityType: 'Image',
          entityId: comment.imageId,
          userId: comment.userId,
          metricType: 'commentCount',
          metricValue: 1,
          createdAt: comment.createdAt,
        });
      }

      if (comment.articleId) {
        addMetrics({
          entityType: 'Article',
          entityId: comment.articleId,
          userId: comment.userId,
          metricType: 'commentCount',
          metricValue: 1,
          createdAt: comment.createdAt,
        });
      }

      if (comment.bountyId) {
        addMetrics({
          entityType: 'Bounty',
          entityId: comment.bountyId,
          userId: comment.userId,
          metricType: 'commentCount',
          metricValue: 1,
          createdAt: comment.createdAt,
        });
      }
    });
  },
};
