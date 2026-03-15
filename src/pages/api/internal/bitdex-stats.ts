import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import { clickhouse } from '~/server/clickhouse/client';

/**
 * BitDex comparison stats endpoint.
 *
 * Returns ground-truth data from Postgres and ClickHouse for comparing
 * against BitDex index values.
 *
 * GET /api/internal/bitdex-stats?token=<WEBHOOK_TOKEN>
 */
export default WebhookEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const [countResult, maxIdResult, publishedResult] = await Promise.all([
    dbRead.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM "Image"`,
    dbRead.$queryRaw<[{ max: number }]>`SELECT MAX(id) as max FROM "Image"`,
    dbRead.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM "Image"
      WHERE "publishedAt" IS NOT NULL AND "publishedAt" <= NOW()
    `,
  ]);

  let topByReactions: { entityId: number; total: number }[] = [];
  if (clickhouse) {
    topByReactions = await clickhouse.$query<{ entityId: number; total: number }>(`
      SELECT entityId, sum(total) as total
      FROM entityMetricDailyAgg
      WHERE entityType = 'Image' AND metricType = 'ReactionLike'
      GROUP BY entityId
      ORDER BY total DESC
      LIMIT 5
    `);
  }

  return res.status(200).json({
    postgres: {
      imageCount: Number(countResult[0].count),
      maxImageId: maxIdResult[0].max,
      publishedCount: Number(publishedResult[0].count),
    },
    clickhouse: {
      topByReactions: topByReactions.map((r) => ({
        entityId: r.entityId,
        reactionCount: Number(r.total),
      })),
    },
  });
});
