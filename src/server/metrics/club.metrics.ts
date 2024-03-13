import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { Prisma } from '@prisma/client';

export const clubMetrics = createMetricProcessor({
  name: 'Club',
  async update({ db, lastUpdate }) {
    return;
    // Disabled for now

    const recentEngagementSubquery = Prisma.sql`
    -- Get all engagements that have happened since then that affect metrics
    WITH recent_engagements AS
    (
      SELECT
          COALESCE(c.id, ct."clubId") "id"
      FROM "EntityAccess" ea
      LEFT JOIN "Club" c ON ea."accessorId" = c.id AND ea."accessorType" = 'Club'
      LEFT JOIN "ClubTier" ct ON ea."accessorId" = ct."id" AND ea."accessorType" = 'ClubTier'
      WHERE COALESCE(c.id, ct."clubId") IS NOT NULL AND ea."addedAt" > ${lastUpdate}

      UNION

      SELECT
        "clubId" AS id
      FROM "ClubPost"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "clubId" AS id
      FROM "ClubMembership"
      WHERE ("startedAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Club'
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
          JOIN "Club" c ON c.id = r.id
          WHERE r.id IS NOT NULL
      )
      -- upsert metrics for all affected
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "ClubMetric" ("clubId", timeframe, "memberCount", "resourceCount", "clubPostCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN member_count
          WHEN tf.timeframe = 'Year' THEN year_member_count
          WHEN tf.timeframe = 'Month' THEN month_member_count
          WHEN tf.timeframe = 'Week' THEN week_member_count
          WHEN tf.timeframe = 'Day' THEN day_member_count
        END AS member_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN resource_count
          WHEN tf.timeframe = 'Year' THEN year_resource_count
          WHEN tf.timeframe = 'Month' THEN month_resource_count
          WHEN tf.timeframe = 'Week' THEN week_resource_count
          WHEN tf.timeframe = 'Day' THEN day_resource_count
        END AS resource_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN club_post_count
          WHEN tf.timeframe = 'Year' THEN year_club_post_count
          WHEN tf.timeframe = 'Month' THEN month_club_post_count
          WHEN tf.timeframe = 'Week' THEN week_club_post_count
          WHEN tf.timeframe = 'Day' THEN day_club_post_count
        END AS club_post_count
      FROM
      (
        SELECT
          a.id,
          COALESCE(cm.member_count, 0) AS member_count,
          COALESCE(cm.year_member_count, 0) AS year_member_count,
          COALESCE(cm.month_member_count, 0) AS month_member_count,
          COALESCE(cm.week_member_count, 0) AS week_member_count,
          COALESCE(cm.day_member_count, 0) AS day_member_count,
          COALESCE(ea.resource_count, 0) AS resource_count,
          COALESCE(ea.year_resource_count, 0) AS year_resource_count,
          COALESCE(ea.month_resource_count, 0) AS month_resource_count,
          COALESCE(ea.week_resource_count, 0) AS week_resource_count,
          COALESCE(ea.day_resource_count, 0) AS day_resource_count,
          COALESCE(cp.club_post_count, 0) AS club_post_count,
          COALESCE(cp.year_club_post_count, 0) AS year_club_post_count,
          COALESCE(cp.month_club_post_count, 0) AS month_club_post_count,
          COALESCE(cp.week_club_post_count, 0) AS week_club_post_count,
          COALESCE(cp.day_club_post_count, 0) AS day_club_post_count
        FROM affected a
        LEFT JOIN (
            SELECT
              cm."clubId",
              COUNT(*) AS member_count,
              SUM(IIF(cm."startedAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_member_count,
              SUM(IIF(cm."startedAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_member_count,
              SUM(IIF(cm."startedAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_member_count,
              SUM(IIF(cm."startedAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_member_count
            FROM "ClubMembership" cm
            WHERE cm."expiresAt" IS NULL OR cm."expiresAt" > NOW()
            GROUP BY cm."clubId"
        ) cm ON cm."clubId" = a.id
        LEFT JOIN (
          SELECT
            COALESCE(c.id, ct."clubId") "clubId",
            COUNT(DISTINCT CONCAT(ea."accessToType", '-', ea."accessToId")) AS resource_count,
            -- TODO: This sum might be innacurate if an item was added to multiple tiers. We should probably
            -- figure out a way to dedupe, but since we mostly care for all time right now, might move on.
            SUM(IIF(ea."addedAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_resource_count,
            SUM(IIF(ea."addedAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_resource_count,
            SUM(IIF(ea."addedAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_resource_count,
            SUM(IIF(ea."addedAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_resource_count
          FROM "EntityAccess" ea
          LEFT JOIN "Club" c ON ea."accessorId" = c.id AND ea."accessorType" = 'Club'
          LEFT JOIN "ClubTier" ct ON ea."accessorId" = ct."id" AND ea."accessorType" = 'ClubTier'
          WHERE  ea."accessorType" IN ('Club', 'ClubTier')
            AND COALESCE(c.id, ct."clubId") IS NOT NULL
          GROUP BY COALESCE(c.id, ct."clubId")
        ) ea ON ea."clubId" = a.id
        LEFT JOIN (
          SELECT
            cp."clubId",
            COUNT(*) AS club_post_count,
            SUM(IIF(cp."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_club_post_count,
            SUM(IIF(cp."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_club_post_count,
            SUM(IIF(cp."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_club_post_count,
            SUM(IIF(cp."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_club_post_count
          FROM "ClubPost" cp
          GROUP BY cp."clubId"
        ) cp ON cp."clubId" = a.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("clubId", timeframe) DO UPDATE
        SET "memberCount" = EXCLUDED."memberCount", "resourceCount" = EXCLUDED."resourceCount","clubPostCount" = EXCLUDED."clubPostCount";
    `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "ClubMetric" SET "memberCount" = 0, "resourceCount" = 0, "clubPostCount" = 0  WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'ClubRank',
    primaryKey: 'clubId',
    refreshInterval: 5 * 60 * 1000,
  },
});
