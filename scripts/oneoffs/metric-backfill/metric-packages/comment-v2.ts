import type { MigrationPackage } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createFilteredIdRangeFetcher } from './base';

type CommentRow = {
  entityId: number;
  entityType: 'Post' | 'Image' | 'Article' | 'Bounty';
  userId: number;
  createdAt: Date;
};

export const commentV2Package: MigrationPackage<CommentRow> = {
  queryBatchSize: 5000,
  range: createFilteredIdRangeFetcher('CommentV2', 'createdAt', `"createdAt" >= '${START_DATE}' AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CommentRow>(
      `SELECT COALESCE(
                COALESCE(r."postId", t."postId"),
                COALESCE(r."imageId", t."imageId"),
                COALESCE(r."articleId", t."articleId"),
                COALESCE(r."bountyId", t."bountyId")
              ) as "entityId",
              CASE
                WHEN COALESCE(r."postId", t."postId") IS NOT NULL THEN 'Post'
                WHEN COALESCE(r."imageId", t."imageId") IS NOT NULL THEN 'Image'
                WHEN COALESCE(r."articleId", t."articleId") IS NOT NULL THEN 'Article'
                WHEN COALESCE(r."bountyId", t."bountyId") IS NOT NULL THEN 'Bounty'
              END as "entityType",
              c."userId", c."createdAt"
       FROM "CommentV2" c
       JOIN "Thread" t ON c."threadId" = t.id
       LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
       WHERE c.id >= $1
         AND c.id <= $2`,
      [start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((comment) => {
      if (comment.entityId && comment.entityType) {
        addMetrics({
          entityType: comment.entityType,
          entityId: comment.entityId,
          userId: comment.userId,
          metricType: 'commentCount',
          metricValue: 1,
          createdAt: comment.createdAt,
        });
      }
    });
  },
};
