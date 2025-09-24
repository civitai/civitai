import { createEntityMetricsCache, getMetricValue } from './entity-metrics.cache-helper';
import { dbRead } from '~/server/db/client';

export type UserMetricLookup = {
  userId: number;
  followerCount: number | null;
  uploadCount: number | null;
  downloadCount: number | null;
  engagementScore: number | null;
};

/**
 * Get additional user metrics from PostgreSQL
 */
async function getUserAdditionalMetrics(userIds: number[]): Promise<Map<number, Partial<UserMetricLookup>>> {
  // Get all additional metrics in parallel
  const [uploadCounts, downloadCounts, engagementScores] = await Promise.all([
    getUserUploadCounts(userIds),
    getUserDownloadCounts(userIds),
    getUserEngagementScores(userIds),
  ]);

  const results = new Map<number, Partial<UserMetricLookup>>();
  for (const userId of userIds) {
    results.set(userId, {
      uploadCount: uploadCounts.get(userId) || null,
      downloadCount: downloadCounts.get(userId) || null,
      engagementScore: engagementScores.get(userId) || null,
    });
  }

  return results;
}

/**
 * User metrics cache using direct Redis entity metrics plus derived metrics
 * Follows the same pattern as imageMetricsCache
 * Metrics are populated from existing PostgreSQL UserMetric table and ClickHouse events
 */
export const userMetricsCache = createEntityMetricsCache<UserMetricLookup>({
  entityType: 'User',
  transformMetrics: (entityId, metrics) => ({
    userId: entityId,
    followerCount: getMetricValue(metrics, 'Follow'),
    uploadCount: null, // Will be filled by additionalDataFetcher
    downloadCount: null, // Will be filled by additionalDataFetcher
    engagementScore: null, // Will be filled by additionalDataFetcher
  }),
  additionalDataFetcher: getUserAdditionalMetrics,
});

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