import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import { clickhouse } from '~/server/clickhouse/client';
import { redis } from '~/server/redis/client';
import { imageMetricAggSource } from '~/server/flipt/client';
import { MetricService } from '../../../../event-engine-common/services/metrics';
import type {
  IClickhouseClient,
  IRedisClient,
} from '../../../../event-engine-common/types/package-stubs';

/**
 * BitDex comparison stats endpoint — lightweight ground-truth lookups.
 *
 * All queries use index scans or pg_class estimates. No full table scans.
 * Query timeout: 5s via statement_timeout.
 *
 * Base:
 *   GET /api/internal/bitdex-stats?token=<WEBHOOK_TOKEN>
 *   Returns: imageCountEstimate (pg_class), maxImageId (index scan)
 *
 * Spot-check specific images (by ID):
 *   GET /api/internal/bitdex-stats?token=<WEBHOOK_TOKEN>&ids=123,456,789
 *   Returns: base stats + per-image data from PG (sortAt, nsfwLevel, blockedFor, poi, minor)
 *   and metrics from Redis/ClickHouse (reactionLike, comment, collection, etc.)
 *   Max 50 IDs per request.
 */
export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Set a 5-second statement timeout for all PG queries in this request
  await dbRead.$executeRawUnsafe(`SET LOCAL statement_timeout = '5000'`);

  // Base stats — all use index scans, sub-millisecond
  const [estimateResult, maxIdResult] = await Promise.all([
    dbRead.$queryRaw<[{ estimate: bigint }]>`
      SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'Image'
    `,
    dbRead.$queryRaw<[{ max: number }]>`SELECT MAX(id) as max FROM "Image"`,
  ]);

  const result: Record<string, unknown> = {
    imageCountEstimate: Number(estimateResult[0].estimate),
    maxImageId: maxIdResult[0].max,
  };

  // Spot-check specific IDs (optional, max 50)
  const idsParam = req.query.ids?.toString();
  if (idsParam) {
    const ids = idsParam.split(',').map(Number).filter(Boolean).slice(0, 50);
    if (ids.length > 0) {
      // PG lookup — uses primary key index scan
      const images = await dbRead.image.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          sortAt: true,
          nsfwLevel: true,
          userId: true,
          type: true,
          postId: true,
          blockedFor: true,
          poi: true,
          minor: true,
        },
      });

      // Metrics from the watcher-fed `metrics:*` cache (MetricService, backed by
      // the FINAL entityMetricDailyAgg_v2 view), per-ID with stampede caching.
      const metricService = new MetricService(
        clickhouse as IClickhouseClient,
        redis as unknown as IRedisClient,
        imageMetricAggSource
      );
      const metrics = await metricService.fetch('Image', ids);

      result.images = images.map((img) => {
        const m = metrics[img.id];
        return {
          ...img,
          metrics: m
            ? {
                reactionLike: m.Like ?? 0,
                reactionHeart: m.Heart ?? 0,
                reactionLaugh: m.Laugh ?? 0,
                reactionCry: m.Cry ?? 0,
                comment: m.commentCount ?? 0,
                collection: m.Collection ?? 0,
                buzz: m.tippedAmount ?? 0,
              }
            : null,
        };
      });
    }
  }

  return res.status(200).json(result);
});
