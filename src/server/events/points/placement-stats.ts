import { createHash } from 'crypto';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { hatPlacementViewsSql } from '~/server/events/points/placement-stats.sql';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { createSingleFlight, fetchThroughCache } from '~/server/utils/cache-helpers';

// The hats page is hot: a slow ClickHouse must cost it nothing. The query gets a short cap, and
// after a failure this pod skips it for a minute rather than queueing more behind it.
const QUERY_CAP_S = 10;
const BACKOFF_MS = 60_000;
let skipUntil = 0;
// One read per user at a time on this pod; the cache lock does the same across pods.
const perUser = createSingleFlight();

type Placement = {
  cosmeticId: number;
  claimKey: string;
  entityType: string;
  entityId: number;
  startedAt: Date;
};
export type PlacementViews = { cosmeticId: number; claimKey: string; views: number };

async function openPlacements(event: string, userId: number) {
  return dbRead.$queryRaw<Placement[]>`
    SELECT "cosmeticId", "claimKey", "entityType"::text AS "entityType", "entityId", "startedAt"
    FROM "EventCosmeticPlacement"
    WHERE "userId" = ${userId} AND event = ${event} AND "endedAt" IS NULL
  `;
}

async function queryPlacementViews(
  event: string,
  userId: number,
  placements: Placement[],
  now: Date
): Promise<PlacementViews[]> {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  try {
    const result = await clickhouse.query({
      query: hatPlacementViewsSql,
      format: 'JSONEachRow',
      abort_signal: AbortSignal.timeout((QUERY_CAP_S + 2) * 1000),
      clickhouse_settings: { max_execution_time: QUERY_CAP_S },
      query_params: {
        event,
        userId,
        from: formatClickhouseDateTime64(
          new Date(Math.min(...placements.map((p) => p.startedAt.getTime())))
        ),
        to: formatClickhouseDateTime64(now),
        placements: placements.map((p) => [
          p.cosmeticId,
          p.claimKey,
          p.entityType,
          p.entityId,
          formatClickhouseDateTime64(p.startedAt),
        ]),
      },
    });
    const rows = await result.json<PlacementViews>();
    return placements.map(({ cosmeticId, claimKey }) => {
      const row = rows.find((r) => Number(r.cosmeticId) === cosmeticId && r.claimKey === claimKey);
      return { cosmeticId, claimKey, views: Number(row?.views ?? 0) };
    });
  } catch (error) {
    skipUntil = Date.now() + BACKOFF_MS;
    throw error;
  }
}

/**
 * How many signed-in views each of the user's placed hats has had on what it is on now, since it
 * went on. Null when it could not be read: the caller shows nothing rather than failing.
 */
export async function getHatPlacementViews(
  event: string,
  userId: number,
  now = new Date()
): Promise<PlacementViews[] | null> {
  if (Date.now() < skipUntil) return null;
  try {
    return await perUser(`${event}:${userId}`, async () => {
      const placements = await openPlacements(event, userId);
      if (!placements.length) return [];
      const hash = createHash('sha1')
        .update(
          placements
            .map(
              (p) => `${p.cosmeticId}:${p.claimKey}:${p.entityType}:${p.entityId}:${+p.startedAt}`
            )
            .sort()
            .join('|')
        )
        .digest('hex')
        .slice(0, 16);
      const key =
        `${REDIS_KEYS.CACHES.EVENT_HAT_PLACEMENT_STATS}:${event}:${userId}:${hash}` as RedisKeyTemplateCache;
      // The lock outlives the query, so a second pod waits for the first instead of querying too.
      return fetchThroughCache(key, () => queryPlacementViews(event, userId, placements, now), {
        ttl: CacheTTL.md,
        lockTTL: QUERY_CAP_S + 5,
      });
    });
  } catch (error) {
    logToAxiom({
      type: 'warning',
      name: 'hat-placement-views',
      message: error instanceof Error ? error.message : String(error),
      event,
    }).catch(() => undefined);
    return null;
  }
}
