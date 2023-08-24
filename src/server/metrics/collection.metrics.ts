import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { Prisma, SearchIndexUpdateQueueAction } from '@prisma/client';
// import { collectionSearchIndex } from '~/server/search-index';

export const collectionMetrics = createMetricProcessor({
  name: 'Collection',
  async update({ db, lastUpdate }) {
    const recentEngagementSubquery = Prisma.sql`
    -- Get all engagements that have happened since then that affect metrics
    WITH recent_engagements AS
    (
      SELECT
        "collectionId" AS id
      FROM "CollectionItem"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "collectionId" AS id
      FROM "CollectionContributor"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "Collection"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Collection'
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
          JOIN "Collection" c ON c.id = r.id
          WHERE r.id IS NOT NULL
      )

      -- upsert metrics for all affected
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "CollectionMetric" ("collectionId", timeframe, "followerCount", "itemCount", "contributorCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN follower_count
          WHEN tf.timeframe = 'Year' THEN year_follower_count
          WHEN tf.timeframe = 'Month' THEN month_follower_count
          WHEN tf.timeframe = 'Week' THEN week_follower_count
          WHEN tf.timeframe = 'Day' THEN day_follower_count
        END AS follower_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN item_count
          WHEN tf.timeframe = 'Year' THEN year_item_count
          WHEN tf.timeframe = 'Month' THEN month_item_count
          WHEN tf.timeframe = 'Week' THEN week_item_count
          WHEN tf.timeframe = 'Day' THEN day_item_count
        END AS item_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN contributor_count
          WHEN tf.timeframe = 'Year' THEN year_contributor_count
          WHEN tf.timeframe = 'Month' THEN month_contributor_count
          WHEN tf.timeframe = 'Week' THEN week_contributor_count
          WHEN tf.timeframe = 'Day' THEN day_contributor_count
        END AS contributor_count
      FROM
      (
        SELECT
          a.id,
          COALESCE(cc.follower_count, 0) AS follower_count,
          COALESCE(cc.year_follower_count, 0) AS year_follower_count,
          COALESCE(cc.month_follower_count, 0) AS month_follower_count,
          COALESCE(cc.week_follower_count, 0) AS week_follower_count,
          COALESCE(cc.day_follower_count, 0) AS day_follower_count,
          COALESCE(i.item_count, 0) AS item_count,
          COALESCE(i.year_item_count, 0) AS year_item_count,
          COALESCE(i.month_item_count, 0) AS month_item_count,
          COALESCE(i.week_item_count, 0) AS week_item_count,
          COALESCE(i.day_item_count, 0) AS day_item_count,
          COALESCE(cc.contributor_count, 0) AS contributor_count,
          COALESCE(cc.year_contributor_count, 0) AS year_contributor_count,
          COALESCE(cc.month_contributor_count, 0) AS month_contributor_count,
          COALESCE(cc.week_contributor_count, 0) AS week_contributor_count,
          COALESCE(cc.day_contributor_count, 0) AS day_contributor_count
        FROM affected a
        LEFT JOIN (
          SELECT
              cc."collectionId",
              SUM(IIF('VIEW' = ANY(cc.permissions), 1, 0)) follower_count,
              SUM(IIF('VIEW' = ANY(cc.permissions) AND cc."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_follower_count,
              SUM(IIF('VIEW' = ANY(cc.permissions) AND cc."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_follower_count,
              SUM(IIF('VIEW' = ANY(cc.permissions) AND cc."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_follower_count,
              SUM(IIF('VIEW' = ANY(cc.permissions) AND cc."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_follower_count,
              SUM(IIF(('ADD' = ANY(cc.permissions) OR 'ADD_REVIEW' = ANY(cc.permissions)), 1, 0)) contributor_count,
              SUM(IIF(('ADD' = ANY(cc.permissions) OR 'ADD_REVIEW' = ANY(cc.permissions)) AND cc."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_contributor_count,
              SUM(IIF(('ADD' = ANY(cc.permissions) OR 'ADD_REVIEW' = ANY(cc.permissions)) AND cc."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_contributor_count,
              SUM(IIF(('ADD' = ANY(cc.permissions) OR 'ADD_REVIEW' = ANY(cc.permissions)) AND cc."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_contributor_count,
              SUM(IIF(('ADD' = ANY(cc.permissions) OR 'ADD_REVIEW' = ANY(cc.permissions)) AND cc."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_contributor_count
          FROM "CollectionContributor" cc
          GROUP BY cc."collectionId"
        ) cc ON cc."collectionId" = a.id
        LEFT JOIN (
          SELECT
            i."collectionId",
            COUNT(*) item_count,
            SUM(IIF(i."createdAt" > now() - INTERVAL '1 year', 1, 0)) year_item_count,
            SUM(IIF(i."createdAt" > now() - INTERVAL '1 month', 1, 0)) month_item_count,
            SUM(IIF(i."createdAt" > now() - INTERVAL '1 week', 1, 0)) week_item_count,
            SUM(IIF(i."createdAt" > now() - INTERVAL '1 day', 1, 0)) day_item_count
          FROM "CollectionItem" i
          GROUP BY i."collectionId"
        ) i ON i."collectionId" = a.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("collectionId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "itemCount" = EXCLUDED."itemCount", "collaboratorCount" = EXCLUDED."collaboratorCount";
    `;

    const affected = await db.$queryRaw<{ id: number }[]>`
      ${recentEngagementSubquery}
      SELECT DISTINCT
          r.id
      FROM recent_engagements r
      JOIN "Collection" c ON c.id = r.id
      WHERE r.id IS NOT NULL
    `;

    // TODO.luis: Re-enable this when we have a search index
    // await collectionsSearchIndex.queueUpdate(
    //   affected.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    // );
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "CollectionMetric" SET "followerCount" = 0, "itemCount" = 0, "collaboratorCount" = 0 WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'CollectionRank',
    primaryKey: 'collectionId',
    refreshInterval: 5 * 60 * 1000,
  },
});
