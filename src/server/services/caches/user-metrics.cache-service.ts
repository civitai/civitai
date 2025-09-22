import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { populateEntityMetrics } from '~/server/redis/entity-metric-populate';
import { dbRead } from '~/server/db/client';
import { clickhouse } from '~/server/clickhouse/client';
import type { CachedObject } from '~/server/utils/cache-helpers';
import { Prisma } from '@prisma/client';

export type UserMetricLookup = {
  userId: number;
  followingCount: number | null;
  followerCount: number | null;
  reactionCount: number | null;
  hiddenCount: number | null;
  uploadCount: number | null;
  reviewCount: number | null;
};

/**
 * User metrics cache using direct Redis entity metrics plus derived metrics
 * Follows the same pattern as imageMetricsCache
 * Metrics are populated from existing PostgreSQL UserMetric table and ClickHouse events
 */
export const userMetricsCache: Pick<
  CachedObject<UserMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, UserMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('User', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('User', ids);

    // Get derived metrics in parallel
    const [uploadCounts, downloadCounts, engagementScores] = await Promise.all([
      getUserUploadCounts(ids),
      getUserDownloadCounts(ids),
      getUserEngagementScores(ids),
    ]);

    const results: Record<string, UserMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);
      results[id] = {
        userId: id,
        followerCount: metrics?.Follow || null,
        uploadCount: uploadCounts.get(id) || null,
        downloadCount: downloadCounts.get(id) || null,
        engagementScore: engagementScores.get(id) || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('User', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('User', ids, true);
  },

  flush: async () => {
    // Clear all user metrics from Redis - Not Supported
  },
};

/**
 * Get upload counts for users from UserMetric table (maintained by user.metrics.ts)
 */
async function getUserUploadCounts(userIds: number[]): Promise<Map<number, number>> {
  const uploadCounts = new Map<number, number>();

  // Get upload counts from UserMetric table (AllTime timeframe)
  const metrics = await dbRead.userMetric.findMany({
    where: {
      userId: { in: userIds },
      timeframe: 'AllTime',
    },
    select: {
      userId: true,
      uploadCount: true,
    },
  });

  // Map the results
  for (const metric of metrics) {
    uploadCounts.set(metric.userId, metric.uploadCount);
  }

  // Ensure all users have an entry (0 if no uploads)
  for (const userId of userIds) {
    if (!uploadCounts.has(userId)) {
      uploadCounts.set(userId, 0);
    }
  }

  return uploadCounts;
}

/**
 * Get download counts for users (sum of their model version downloads)
 */
async function getUserDownloadCounts(userIds: number[]): Promise<Map<number, number>> {
  const downloadCounts = new Map<number, number>();

  // Get download counts by summing model version downloads for user's models
  const results = await dbRead.$queryRaw<{ userId: number; downloads: number }[]>`
    SELECT
      m."userId",
      COALESCE(SUM(mvm."downloadCount"), 0)::int as downloads
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
      AND mvm.timeframe = 'AllTime'
    WHERE m."userId" = ANY(${userIds})
      AND mv.status = 'Published'
    GROUP BY m."userId"
  `;

  for (const row of results) {
    downloadCounts.set(row.userId, row.downloads);
  }

  // Ensure all users have an entry (0 if no downloads)
  for (const userId of userIds) {
    if (!downloadCounts.has(userId)) {
      downloadCounts.set(userId, 0);
    }
  }

  return downloadCounts;
}

/**
 * Get engagement scores for users (derived from UserMetric reaction counts + other metrics)
 */
async function getUserEngagementScores(userIds: number[]): Promise<Map<number, number>> {
  const engagementScores = new Map<number, number>();

  // Get engagement metrics from UserMetric table
  const metrics = await dbRead.userMetric.findMany({
    where: {
      userId: { in: userIds },
      timeframe: 'AllTime',
    },
    select: {
      userId: true,
      reactionCount: true,
      followerCount: true,
      uploadCount: true,
      reviewCount: true,
    },
  });

  for (const metric of metrics) {
    // Calculate engagement score based on various metrics
    // Higher weights for followers and reactions as they indicate quality content
    const score =
      metric.reactionCount * 2 +    // Reactions received on content
      metric.followerCount * 3 +     // Users following
      metric.uploadCount * 1 +        // Content created
      metric.reviewCount * 2;         // Reviews written

    engagementScores.set(metric.userId, score);
  }

  // Ensure all users have an entry (0 if no engagement)
  for (const userId of userIds) {
    if (!engagementScores.has(userId)) {
      engagementScores.set(userId, 0);
    }
  }

  return engagementScores;
}
