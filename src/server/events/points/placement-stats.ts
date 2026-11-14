import { createHash } from 'crypto';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { eventPointKeys, eventPointSeason } from '~/server/events/points/keys';
import { hatPlacementStatsSql } from '~/server/events/points/placement-stats.sql';
import {
  totalPlacementRows,
  type PlacementStats,
  type PlacementStatsRow,
} from '~/server/events/points/placement-stats.rows';
import {
  MAX_INT32,
  refereeQueryParams,
  refereeWindow,
  restrictedAmong,
  type RefereeEvent,
} from '~/server/events/points/referee';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, sysRedis, type RedisKeyTemplateCache } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

// The inventory page is hot: a slow ClickHouse must cost it nothing. The query gets a short cap,
// and after a failure this pod skips it for a minute rather than queueing more behind it.
const QUERY_CAP_S = 10;
const BACKOFF_MS = 60_000;
let skipUntil = 0;

type Placement = {
  cosmeticId: number;
  claimKey: string;
  entityType: string;
  entityId: number;
  startedAt: Date;
};

const startOfUtcDay = (time: Date) =>
  new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));

async function openPlacements(event: string, userId: number) {
  return dbRead.$queryRaw<Placement[]>`
    SELECT "cosmeticId", "claimKey", "entityType"::text AS "entityType", "entityId", "startedAt"
    FROM "EventCosmeticPlacement"
    WHERE "userId" = ${userId} AND event = ${event} AND "endedAt" IS NULL
  `;
}

async function queryPlacementStats(
  event: RefereeEvent,
  userId: number,
  placements: Placement[],
  now: Date
): Promise<PlacementStats[]> {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const window = refereeWindow(event, eventPointSeason(event.startDate, now), now);
  if (window.cut <= window.start) return placements.map((p) => ({ ...p, points: 0, views: 0 }));
  const earliest = Math.min(...placements.map((p) => p.startedAt.getTime()));
  const recomputeFrom = new Date(
    Math.max(window.start.getTime(), startOfUtcDay(new Date(earliest)).getTime())
  );
  const weights = await sysRedis.hGetAll(eventPointKeys(event.name).weights).catch(() => undefined);
  const result = await clickhouse.query({
    query: hatPlacementStatsSql,
    format: 'JSONEachRow',
    abort_signal: AbortSignal.timeout((QUERY_CAP_S + 2) * 1000),
    clickhouse_settings: { max_execution_time: QUERY_CAP_S },
    query_params: {
      ...refereeQueryParams(event, { ...window, recomputeFrom }, weights, {
        hidden: [],
        newAccountMinId: MAX_INT32,
      }),
      userId,
      placements: placements.map((p) => [
        p.cosmeticId,
        p.claimKey,
        p.entityType,
        p.entityId,
        formatClickhouseDateTime64(p.startedAt),
      ]),
    },
  });
  const rows = (await result.json<PlacementStatsRow>()).map((r) => ({
    cosmeticId: Number(r.cosmeticId),
    claimKey: String(r.claimKey),
    actorId: Number(r.actorId),
    hatPoints: Number(r.hatPoints),
    points: Number(r.points),
    views: Number(r.views),
  }));
  const restricted = await restrictedAmong(event, [
    ...new Set([userId, ...rows.map((r) => r.actorId)]),
  ]);
  const totals = totalPlacementRows(rows, { userId, ...restricted });
  return placements.map(({ cosmeticId, claimKey }) => {
    const t = totals.get(`${cosmeticId}:${claimKey}`);
    return { cosmeticId, claimKey, points: t?.points ?? 0, views: t?.views ?? 0 };
  });
}

/**
 * What each of the user's placed hats has earned on what it is on now, since it went on, counted
 * as the referee counts it. Null when it could not be read: the caller shows nothing rather than
 * failing.
 */
export async function getHatPlacementStats(
  event: RefereeEvent,
  userId: number,
  now = new Date()
): Promise<PlacementStats[] | null> {
  if (Date.now() < skipUntil) return null;
  try {
    const placements = await openPlacements(event.name, userId);
    if (!placements.length) return [];
    const hash = createHash('sha1')
      .update(
        placements
          .map((p) => `${p.cosmeticId}:${p.claimKey}:${p.entityType}:${p.entityId}:${+p.startedAt}`)
          .sort()
          .join('|')
      )
      .digest('hex')
      .slice(0, 16);
    const key =
      `${REDIS_KEYS.CACHES.EVENT_HAT_PLACEMENT_STATS}:${event.name}:${userId}:${hash}` as RedisKeyTemplateCache;
    return await fetchThroughCache(key, () => queryPlacementStats(event, userId, placements, now), {
      ttl: CacheTTL.sm,
    });
  } catch (error) {
    skipUntil = Date.now() + BACKOFF_MS;
    logToAxiom({
      type: 'warning',
      name: 'hat-placement-stats',
      message: error instanceof Error ? error.message : String(error),
      event: event.name,
    }).catch(() => undefined);
    return null;
  }
}
