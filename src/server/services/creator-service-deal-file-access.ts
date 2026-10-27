import { clickhouse } from '~/server/clickhouse/client';
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
  const [row] = await queryAccessLog<{ since: number | null }>(
    `SELECT toUnixTimestamp64Milli(minOrNull(time)) AS since FROM default.serviceDealFileAccess`
  );
  return row?.since == null ? null : new Date(Number(row.since));
}
