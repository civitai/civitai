import type { CheckKey } from '~/pages/api/health';

/**
 * Human-readable label per /api/health dependency check, for the support-agent status report.
 *
 * Deliberately a LEAF module with no runtime imports: the type-only `CheckKey` import erases at
 * compile time, so a test can pin this map against the producer's real key set without pulling
 * either module's dependency graph in.
 *
 * Typed as `Record<CheckKey, string>` so the COMPILER rejects a check added to `checkFns`
 * without a label here, and a label for a check that no longer exists. That is the half a test
 * cannot cover cheaply; `ALL_CHECK_KEYS` covers the runtime half. Both exist because the
 * previous hand-written mirror in the report meant a renamed or removed check silently arrived
 * as an absent key, which the report then described as deliberately disabled.
 */
export const HEALTH_CHECK_LABELS: Record<CheckKey, string> = {
  read: 'Database (read)',
  write: 'Database (write)',
  pgRead: 'PG (read)',
  pgWrite: 'PG (write)',
  redis: 'Redis',
  sysRedis: 'System Redis',
  searchMetrics: 'Search/Metrics',
  clickhouse: 'ClickHouse',
};

/** Render order for the report — stable and independent of object-key order. */
export const HEALTH_CHECK_ORDER: readonly CheckKey[] = [
  'read',
  'write',
  'pgRead',
  'pgWrite',
  'redis',
  'sysRedis',
  'searchMetrics',
  'clickhouse',
];
