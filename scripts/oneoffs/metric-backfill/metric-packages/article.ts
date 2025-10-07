import type { MigrationPackage, EntityMetricEvent } from '../types';
import { START_DATE, CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type ArticleRow = {
  userId: number;
  publishedAt: Date;
};

export const articlePackage: MigrationPackage<ArticleRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('Article', `"publishedAt" IS NOT NULL AND "publishedAt" >= '${START_DATE}' AND "publishedAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<ArticleRow>(
      `SELECT "userId", "publishedAt"
       FROM "Article"
       WHERE "publishedAt" IS NOT NULL
         AND id >= $1
         AND id <= $2
       ORDER BY id`,
      [start, end]
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
