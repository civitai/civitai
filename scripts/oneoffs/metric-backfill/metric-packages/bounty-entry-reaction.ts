import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BountyEntryReactionRow = {
  bountyEntryId: number;
  userId: number;
  reaction: string;
  createdAt: Date;
  entryOwnerId: number;
};

export const bountyEntryReactionPackage: MigrationPackage<BountyEntryReactionRow> = {
  queryBatchSize: 2000,
  range: createIdRangeFetcher('BountyEntryReaction', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BountyEntryReactionRow>(
      `SELECT ber."bountyEntryId", ber."userId", ber."reaction", ber."createdAt",
              be."userId" as "entryOwnerId"
       FROM "BountyEntryReaction" ber
       JOIN "BountyEntry" be ON be.id = ber."bountyEntryId"
       WHERE ber."createdAt" < $1
         AND ber.id >= $2
         AND ber.id <= $3
       ORDER BY ber.id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach((reaction) => {
      // User reactionCount (content owner gets credit)
      addMetrics(
        {
          entityType: 'User',
          entityId: reaction.entryOwnerId,
          userId: reaction.userId,
          metricType: 'reactionCount',
          metricValue: 1,
          createdAt: reaction.createdAt,
        },
        // BountyEntry-specific reaction metrics
        {
          entityType: 'BountyEntry',
          entityId: reaction.bountyEntryId,
          userId: reaction.userId,
          metricType: reaction.reaction,
          metricValue: 1,
          createdAt: reaction.createdAt,
        }
      );
    });
  },
};
