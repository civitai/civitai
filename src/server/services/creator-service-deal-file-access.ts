import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { ServiceDealAccessKind, ServiceDealAccessRole } from '~/server/clickhouse/tracker';

export type ServiceDealFileAccessSummary = {
  dealId: number;
  fileId: number;
  role: ServiceDealAccessRole;
  kind: ServiceDealAccessKind;
  count: number;
  firstAt: Date;
  lastAt: Date;
};

const ACCESS_READ_TIMEOUT_SECONDS = 5;

// Throws when ClickHouse is not configured: an unreadable log must not read as "nobody downloaded".
async function queryAccessLog<T>(query: string, query_params: Record<string, unknown> = {}) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const response = await clickhouse.query({
    query,
    query_params,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: ACCESS_READ_TIMEOUT_SECONDS },
    abort_signal: AbortSignal.timeout((ACCESS_READ_TIMEOUT_SECONDS + 1) * 1000),
  });
  return (await response.json()) as T[];
}

/** Every recorded access to the given deals' files, one row per file, role and kind. */
export async function listServiceDealFileAccess(
  dealIds: number[]
): Promise<ServiceDealFileAccessSummary[]> {
  if (!dealIds.length) return [];
  const rows = await queryAccessLog<
    Omit<ServiceDealFileAccessSummary, 'firstAt' | 'lastAt'> & { firstAt: number; lastAt: number }
  >(
    `SELECT dealId, fileId, role, kind, toUInt32(count()) AS count,
      toUnixTimestamp64Milli(min(time)) AS firstAt, toUnixTimestamp64Milli(max(time)) AS lastAt
    FROM default.serviceDealFileAccess
    WHERE dealId IN {dealIds:Array(UInt32)}
    GROUP BY dealId, fileId, role, kind
    ORDER BY dealId, fileId, role, kind`,
    { dealIds }
  );
  return rows.map((row) => ({
    ...row,
    firstAt: new Date(Number(row.firstAt)),
    lastAt: new Date(Number(row.lastAt)),
  }));
}

/** When the first access was recorded, or null if none has been: nothing before it was recorded. */
export async function getServiceDealFileAccessRecordedSince() {
  const key = REDIS_KEYS.CREATOR_SERVICES.ACCESS_RECORDED_SINCE;
  // The first row never changes once written, so only a found date is cached: until then each read
  // asks again, and the first download shows up without waiting out a TTL.
  const cached = await redis.packed.get<number>(key).catch(logCacheFailure);
  if (typeof cached === 'number') return new Date(cached);

  const [row] = await queryAccessLog<{ since: number | string | null }>(
    `SELECT toUnixTimestamp64Milli(minOrNull(time)) AS since FROM default.serviceDealFileAccess`
  );
  if (row?.since == null) return null;
  const since = Number(row.since);
  await redis.packed.set(key, since, { EX: CacheTTL.day }).catch(logCacheFailure);
  return new Date(since);
}

const logCacheFailure = (error: unknown) => {
  logToAxiom({
    name: 'creator-service-file-access',
    type: 'warning',
    message: 'Access log cache unavailable',
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => null);
  return null;
};
