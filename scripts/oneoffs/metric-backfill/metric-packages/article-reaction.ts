import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type ArticleReactionRow = {
  articleId: number;
  userId: number;
  reaction: string;
  createdAt: Date;
  articleOwnerId: number;
};

export const articleReactionPackage: MigrationPackage<ArticleReactionRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('ArticleReaction', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<ArticleReactionRow>(
      `SELECT ar."articleId", ar."userId", ar."reaction", ar."createdAt",
              a."userId" as "articleOwnerId"
       FROM "ArticleReaction" ar
       JOIN "Article" a ON a.id = ar."articleId"
       WHERE ar."createdAt" < $1
         AND ar.id >= $2
         AND ar.id <= $3
       ORDER BY ar.id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((reaction) => {
      // User reactionCount (content owner gets credit)
      addMetrics(
        {
          entityType: 'User',
          entityId: reaction.articleOwnerId,
          userId: reaction.userId,
          metricType: 'reactionCount',
          metricValue: 1,
          createdAt: reaction.createdAt,
        },
        // Article-specific reaction metrics
        {
          entityType: 'Article',
          entityId: reaction.articleId,
          userId: reaction.userId,
          metricType: reaction.reaction,
          metricValue: 1,
          createdAt: reaction.createdAt,
        }
      );
    });
  },
};
