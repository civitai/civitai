import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type ArticleRow = {
  userId: number;
  publishedAt: Date;
};

export const articlePackage: MigrationPackage<ArticleRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('Article', `"publishedAt" IS NOT NULL AND "publishedAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<ArticleRow>(
      `SELECT "userId", "publishedAt"
       FROM "Article"
       WHERE "publishedAt" IS NOT NULL
         AND "publishedAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((article) => {
      addMetrics({
        entityType: 'User',
        entityId: article.userId,
        userId: article.userId,
        metricType: 'articleCount',
        metricValue: 1,
        createdAt: article.publishedAt,
      });
    });
  },
};
