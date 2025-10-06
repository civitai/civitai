import type { MigrationPackage } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createFilteredIdRangeFetcher, createIdRangeFetcher } from './base';

type CommentRow = {
  modelId: number;
  userId: number;
  createdAt: Date;
};

export const commentPackage: MigrationPackage<CommentRow> = {
  queryBatchSize: 5000,
  range: createFilteredIdRangeFetcher('Comment', 'createdAt', `"modelId" IS NOT NULL AND "createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<CommentRow>(
      `SELECT "modelId", "userId", "createdAt"
       FROM "Comment"
       WHERE "modelId" IS NOT NULL
         AND id >= $1
         AND id <= $2
       ORDER BY id`,
      [start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((comment) => {
      addMetrics({
        entityType: 'Model',
        entityId: comment.modelId,
        userId: comment.userId,
        metricType: 'commentCount',
        metricValue: 1,
        createdAt: comment.createdAt,
      });
    });
  },
};
