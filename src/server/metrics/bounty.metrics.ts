import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { Prisma } from '@prisma/client';

export const bountyMetrics = createMetricProcessor({
  name: 'Bounty',
  async update({ db, lastUpdate }) {
    const recentEngagementSubquery = Prisma.sql`
    -- Get all engagements that have happened since then that affect metrics
    WITH recent_engagements AS
    (
      SELECT
        "bountyId" AS id
      FROM "BountyEngagement"
      WHERE ("createdAt" > ${lastUpdate})

      UNION
      
      SELECT
        "bountyId" AS id
      FROM "BountyEntry"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "bountyId" AS id
      FROM "BountyBenefactor"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "Bounty"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Bounty'
    )
    `;

    await db.$executeRaw`
      ${recentEngagementSubquery},
      -- Get all affected
      affected AS
      (
          SELECT DISTINCT
              r.id
          FROM recent_engagements r
          JOIN "Bounty" b ON b.id = r.id
          WHERE r.id IS NOT NULL
      )
      -- upsert metrics for all affected
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "BountyMetric" ("bountyId", timeframe, "favoriteCount", "trackCount", "entryCount", "benefactorCount", "unitAmountCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN favorite_count
          WHEN tf.timeframe = 'Year' THEN year_favorite_count
          WHEN tf.timeframe = 'Month' THEN month_favorite_count
          WHEN tf.timeframe = 'Week' THEN week_favorite_count
          WHEN tf.timeframe = 'Day' THEN day_favorite_count
        END AS favorite_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN track_count
          WHEN tf.timeframe = 'Year' THEN year_track_count
          WHEN tf.timeframe = 'Month' THEN month_track_count
          WHEN tf.timeframe = 'Week' THEN week_track_count
          WHEN tf.timeframe = 'Day' THEN day_track_count
        END AS track_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN entry_count
          WHEN tf.timeframe = 'Year' THEN year_entry_count
          WHEN tf.timeframe = 'Month' THEN month_entry_count
          WHEN tf.timeframe = 'Week' THEN week_entry_count
          WHEN tf.timeframe = 'Day' THEN day_entry_count
        END AS entry_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN benefactor_count
          WHEN tf.timeframe = 'Year' THEN year_benefactor_count
          WHEN tf.timeframe = 'Month' THEN month_benefactor_count
          WHEN tf.timeframe = 'Week' THEN week_benefactor_count
          WHEN tf.timeframe = 'Day' THEN day_benefactor_count
        END AS benefactor_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN unit_amount_count
          WHEN tf.timeframe = 'Year' THEN year_unit_amount_count
          WHEN tf.timeframe = 'Month' THEN month_unit_amount_count
          WHEN tf.timeframe = 'Week' THEN week_unit_amount_count
          WHEN tf.timeframe = 'Day' THEN day_unit_amount_count
        END AS unit_amount_count
      FROM
      (
        SELECT
          a.id,
          COALESCE(be.favorite_count, 0) AS favorite_count,
          COALESCE(be.year_favorite_count, 0) AS year_favorite_count,
          COALESCE(be.month_favorite_count, 0) AS month_favorite_count,
          COALESCE(be.week_favorite_count, 0) AS week_favorite_count,
          COALESCE(be.day_favorite_count, 0) AS day_favorite_count, 
          COALESCE(be.track_count, 0) AS track_count,
          COALESCE(be.year_track_count, 0) AS year_track_count,
          COALESCE(be.month_track_count, 0) AS month_track_count,
          COALESCE(be.week_track_count, 0) AS week_track_count,
          COALESCE(be.day_track_count, 0) AS day_track_count, 
          COALESCE(bentry.entry_count, 0) AS entry_count,
          COALESCE(bentry.year_entry_count, 0) AS year_entry_count,
          COALESCE(bentry.month_entry_count, 0) AS month_entry_count,
          COALESCE(bentry.week_entry_count, 0) AS week_entry_count,
          COALESCE(bentry.day_entry_count, 0) AS day_entry_count, 
          COALESCE(bf.benefactor_count, 0) AS benefactor_count,
          COALESCE(bf.year_benefactor_count, 0) AS year_benefactor_count,
          COALESCE(bf.month_benefactor_count, 0) AS month_benefactor_count,
          COALESCE(bf.week_benefactor_count, 0) AS week_benefactor_count,
          COALESCE(bf.day_benefactor_count, 0) AS day_benefactor_count, 
          COALESCE(bf.unit_amount_count, 0) AS unit_amount_count,
          COALESCE(bf.year_unit_amount_count, 0) AS year_unit_amount_count,
          COALESCE(bf.month_unit_amount_count, 0) AS month_unit_amount_count,
          COALESCE(bf.week_unit_amount_count, 0) AS week_unit_amount_count,
          COALESCE(bf.day_unit_amount_count, 0) AS day_unit_amount_count
        FROM affected a
        LEFT JOIN (
          SELECT
              be."bountyId",
              SUM(IIF(be.type = 'Favorite'::"BountyEngagementType", 1, 0)) favorite_count,
              SUM(IIF(be.type = 'Favorite'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_favorite_count,
              SUM(IIF(be.type = 'Favorite'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_favorite_count,
              SUM(IIF(be.type = 'Favorite'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_favorite_count,
              SUM(IIF(be.type = 'Favorite'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_favorite_count,
              SUM(IIF(be.type = 'Track'::"BountyEngagementType", 1, 0)) track_count,
              SUM(IIF(be.type = 'Track'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_track_count,
              SUM(IIF(be.type = 'Track'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_track_count,
              SUM(IIF(be.type = 'Track'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_track_count,
              SUM(IIF(be.type = 'Track'::"BountyEngagementType" AND be."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_track_count
          FROM "BountyEngagement" be
          GROUP BY be."bountyId"
        ) be ON be."bountyId" = a.id
        LEFT JOIN (
          SELECT
              bentry."bountyId",
              COUNT(*) entry_count,
              SUM(IIF(bentry."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_entry_count,
              SUM(IIF(bentry."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_entry_count,
              SUM(IIF(bentry."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_entry_count,
              SUM(IIF(bentry."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_entry_count
          FROM "BountyEntry" bentry
          GROUP BY bentry."bountyId"
        ) bentry ON bentry."bountyId" = a.id
        LEFT JOIN (
          SELECT
              bf."bountyId",
              COUNT(*) benefactor_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_benefactor_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_benefactor_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_benefactor_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_benefactor_count,
              SUM(bf."unitAmount") unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 year', bf."unitAmount", 0)) year_unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 month', bf."unitAmount", 0)) month_unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 week', bf."unitAmount", 0)) week_unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 day', bf."unitAmount", 0)) day_unit_amount_count
          FROM "BountyBenefactor" bf
          GROUP BY bf."bountyId"
        ) bf ON bf."bountyId" = a.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("bountyId", timeframe) DO UPDATE
        SET "favoriteCount" = EXCLUDED."favoriteCount", "trackCount" = EXCLUDED."trackCount", "entryCount" = EXCLUDED."entryCount",  "benefactorCount" = EXCLUDED."benefactorCount", "unitAmountCount" = EXCLUDED."unitAmountCount";
    `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "BountyMetric" SET "favoriteCount" = 0, "trackCount" = 0, "entryCount" = 0, "benefactorCount" = 0, "unitAmountCount" = 0  WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'BountyRank',
    primaryKey: 'bountyId',
    refreshInterval: 5 * 60 * 1000,
  },
});
