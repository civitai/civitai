import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { Prisma } from '@prisma/client';

export const bountyEntryMetrics = createMetricProcessor({
  name: 'BountyEntry',
  async update({ db, lastUpdate }) {
    const recentEngagementSubquery = Prisma.sql`
    -- Get all engagements that have happened since then that affect metrics
    WITH recent_engagements AS
    (
      SELECT
        "bountyEntryId" AS id
      FROM "BountyEntryReaction"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "awardedToId" AS id
      FROM "BountyBenefactor"
      WHERE ("createdAt" > ${lastUpdate})

      UNION
      
      SELECT bt."entityId" as id
        FROM "BuzzTip" bt
      WHERE bt."entityId" IS NOT NULL AND bt."entityType" = 'BountyEntry'
        AND (bt."createdAt" > ${lastUpdate} OR bt."updatedAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "BountyEntry"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'BountyEntry'
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
          JOIN "BountyEntry" b ON b.id = r.id
          WHERE r.id IS NOT NULL
      )
      -- upsert metrics for all affected
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "BountyEntryMetric" ("bountyEntryId", timeframe, "likeCount", "dislikeCount", "laughCount", "cryCount", "heartCount", "unitAmountCount", "tippedCount", "tippedAmountCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN like_count
          WHEN tf.timeframe = 'Year' THEN year_like_count
          WHEN tf.timeframe = 'Month' THEN month_like_count
          WHEN tf.timeframe = 'Week' THEN week_like_count
          WHEN tf.timeframe = 'Day' THEN day_like_count
        END AS like_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN dislike_count
          WHEN tf.timeframe = 'Year' THEN year_dislike_count
          WHEN tf.timeframe = 'Month' THEN month_dislike_count
          WHEN tf.timeframe = 'Week' THEN week_dislike_count
          WHEN tf.timeframe = 'Day' THEN day_dislike_count
        END AS dislike_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN laugh_count
          WHEN tf.timeframe = 'Year' THEN year_laugh_count
          WHEN tf.timeframe = 'Month' THEN month_laugh_count
          WHEN tf.timeframe = 'Week' THEN week_laugh_count
          WHEN tf.timeframe = 'Day' THEN day_laugh_count
        END AS laugh_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN cry_count
          WHEN tf.timeframe = 'Year' THEN year_cry_count
          WHEN tf.timeframe = 'Month' THEN month_cry_count
          WHEN tf.timeframe = 'Week' THEN week_cry_count
          WHEN tf.timeframe = 'Day' THEN day_cry_count
        END AS cry_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN heart_count
          WHEN tf.timeframe = 'Year' THEN year_heart_count
          WHEN tf.timeframe = 'Month' THEN month_heart_count
          WHEN tf.timeframe = 'Week' THEN week_heart_count
          WHEN tf.timeframe = 'Day' THEN day_heart_count
        END AS heart_count, 
        CASE
          WHEN tf.timeframe = 'AllTime' THEN unit_amount_count
          WHEN tf.timeframe = 'Year' THEN year_unit_amount_count
          WHEN tf.timeframe = 'Month' THEN month_unit_amount_count
          WHEN tf.timeframe = 'Week' THEN week_unit_amount_count
          WHEN tf.timeframe = 'Day' THEN day_unit_amount_count
        END AS unit_amount_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN tipped_count
          WHEN tf.timeframe = 'Year' THEN year_tipped_count
          WHEN tf.timeframe = 'Month' THEN month_tipped_count
          WHEN tf.timeframe = 'Week' THEN week_tipped_count
          WHEN tf.timeframe = 'Day' THEN day_tipped_count
        END AS tipped_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN tipped_amount_count
          WHEN tf.timeframe = 'Year' THEN year_tipped_amount_count
          WHEN tf.timeframe = 'Month' THEN month_tipped_amount_count
          WHEN tf.timeframe = 'Week' THEN week_tipped_amount_count
          WHEN tf.timeframe = 'Day' THEN day_tipped_amount_count
        END AS tipped_amount_count
      FROM
      (
        SELECT
          a.id,
          COALESCE(ber.heart_count, 0) AS heart_count,
          COALESCE(ber.year_heart_count, 0) AS year_heart_count,
          COALESCE(ber.month_heart_count, 0) AS month_heart_count,
          COALESCE(ber.week_heart_count, 0) AS week_heart_count,
          COALESCE(ber.day_heart_count, 0) AS day_heart_count,
          COALESCE(ber.laugh_count, 0) AS laugh_count,
          COALESCE(ber.year_laugh_count, 0) AS year_laugh_count,
          COALESCE(ber.month_laugh_count, 0) AS month_laugh_count,
          COALESCE(ber.week_laugh_count, 0) AS week_laugh_count,
          COALESCE(ber.day_laugh_count, 0) AS day_laugh_count,
          COALESCE(ber.cry_count, 0) AS cry_count,
          COALESCE(ber.year_cry_count, 0) AS year_cry_count,
          COALESCE(ber.month_cry_count, 0) AS month_cry_count,
          COALESCE(ber.week_cry_count, 0) AS week_cry_count,
          COALESCE(ber.day_cry_count, 0) AS day_cry_count,
          COALESCE(ber.dislike_count, 0) AS dislike_count,
          COALESCE(ber.year_dislike_count, 0) AS year_dislike_count,
          COALESCE(ber.month_dislike_count, 0) AS month_dislike_count,
          COALESCE(ber.week_dislike_count, 0) AS week_dislike_count,
          COALESCE(ber.day_dislike_count, 0) AS day_dislike_count,
          COALESCE(ber.like_count, 0) AS like_count,
          COALESCE(ber.year_like_count, 0) AS year_like_count,
          COALESCE(ber.month_like_count, 0) AS month_like_count,
          COALESCE(ber.week_like_count, 0) AS week_like_count,
          COALESCE(ber.day_like_count, 0) AS day_like_count, 
          COALESCE(bf.unit_amount_count, 0) AS unit_amount_count,
          COALESCE(bf.year_unit_amount_count, 0) AS year_unit_amount_count,
          COALESCE(bf.month_unit_amount_count, 0) AS month_unit_amount_count,
          COALESCE(bf.week_unit_amount_count, 0) AS week_unit_amount_count,
          COALESCE(bf.day_unit_amount_count, 0) AS day_unit_amount_count,
          COALESCE(bt.tipped_count, 0) AS tipped_count,
          COALESCE(bt.year_tipped_count, 0) AS year_tipped_count,
          COALESCE(bt.month_tipped_count, 0) AS month_tipped_count,
          COALESCE(bt.week_tipped_count, 0) AS week_tipped_count,
          COALESCE(bt.day_tipped_count, 0) AS day_tipped_count,
          COALESCE(bt.tipped_amount_count, 0) AS tipped_amount_count,
          COALESCE(bt.year_tipped_amount_count, 0) AS year_tipped_amount_count,
          COALESCE(bt.month_tipped_amount_count, 0) AS month_tipped_amount_count,
          COALESCE(bt.week_tipped_amount_count, 0) AS week_tipped_amount_count,
          COALESCE(bt.day_tipped_amount_count, 0) AS day_tipped_amount_count
        FROM affected a
        LEFT JOIN (
          SELECT
            ber."bountyEntryId",
            SUM(IIF(ber.reaction = 'Heart', 1, 0)) AS heart_count,
            SUM(IIF(ber.reaction = 'Heart' AND ber."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
            SUM(IIF(ber.reaction = 'Heart' AND ber."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
            SUM(IIF(ber.reaction = 'Heart' AND ber."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
            SUM(IIF(ber.reaction = 'Heart' AND ber."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count,
            SUM(IIF(ber.reaction = 'Like', 1, 0)) AS like_count,
            SUM(IIF(ber.reaction = 'Like' AND ber."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_like_count,
            SUM(IIF(ber.reaction = 'Like' AND ber."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_like_count,
            SUM(IIF(ber.reaction = 'Like' AND ber."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_like_count,
            SUM(IIF(ber.reaction = 'Like' AND ber."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_like_count,
            SUM(IIF(ber.reaction = 'Dislike', 1, 0)) AS dislike_count,
            SUM(IIF(ber.reaction = 'Dislike' AND ber."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_dislike_count,
            SUM(IIF(ber.reaction = 'Dislike' AND ber."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_dislike_count,
            SUM(IIF(ber.reaction = 'Dislike' AND ber."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_dislike_count,
            SUM(IIF(ber.reaction = 'Dislike' AND ber."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_dislike_count,
            SUM(IIF(ber.reaction = 'Cry', 1, 0)) AS cry_count,
            SUM(IIF(ber.reaction = 'Cry' AND ber."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_cry_count,
            SUM(IIF(ber.reaction = 'Cry' AND ber."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_cry_count,
            SUM(IIF(ber.reaction = 'Cry' AND ber."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_cry_count,
            SUM(IIF(ber.reaction = 'Cry' AND ber."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_cry_count,
            SUM(IIF(ber.reaction = 'Laugh', 1, 0)) AS laugh_count,
            SUM(IIF(ber.reaction = 'Laugh' AND ber."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_laugh_count,
            SUM(IIF(ber.reaction = 'Laugh' AND ber."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_laugh_count,
            SUM(IIF(ber.reaction = 'Laugh' AND ber."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_laugh_count,
            SUM(IIF(ber.reaction = 'Laugh' AND ber."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_laugh_count
          FROM "BountyEntryReaction" ber
          GROUP BY ber."bountyEntryId"
        ) ber ON ber."bountyEntryId" = a.id
        LEFT JOIN (
          SELECT
              bf."awardedToId",
              SUM(bf."unitAmount") unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 year', bf."unitAmount", 0)) year_unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 month', bf."unitAmount", 0)) month_unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 week', bf."unitAmount", 0)) week_unit_amount_count,
              SUM(IIF(bf."createdAt" > now() - INTERVAL '1 day', bf."unitAmount", 0)) day_unit_amount_count
          FROM "BountyBenefactor" bf
          GROUP BY bf."awardedToId"
        ) bf ON bf."awardedToId" = a.id
        LEFT JOIN (
          SELECT
            abt."entityId" AS id,
            COALESCE(COUNT(*), 0) AS tipped_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_tipped_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_tipped_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_tipped_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_tipped_count,
            COALESCE(SUM(abt.amount), 0) AS tipped_amount_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '365 days'), abt.amount, 0)) AS year_tipped_amount_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '30 days'), abt.amount, 0)) AS month_tipped_amount_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '7 days'), abt.amount, 0)) AS week_tipped_amount_count,
            SUM(IIF(abt."updatedAt" >= (NOW() - interval '1 days'), abt.amount, 0)) AS day_tipped_amount_count
          FROM "BuzzTip" abt
          WHERE abt."entityType" = 'BountyEntry' AND abt."entityId" IS NOT NULL
          GROUP BY abt."entityId"
        ) bt ON a.id = bt.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("bountyEntryId", timeframe) DO UPDATE
        SET "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount",  "cryCount" = EXCLUDED."cryCount", "heartCount" = EXCLUDED."heartCount", "unitAmountCount" = EXCLUDED."unitAmountCount", "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount";
    `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "BountyEntryMetric" SET "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "heartCount" = 0, "unitAmountCount" = 0, "tippedCount" = 0, "tippedAmountCount" = 0 WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'BountyEntryRank',
    primaryKey: 'bountyEntryId',
    refreshInterval: 5 * 60 * 1000,
  },
});
