import type { Pool } from 'pg';
import { config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';

/**
 * Every vector-sync process's pool: each query, and each wait for a free client, is bounded.
 * `batch` is for the backfill and reconcile Jobs, whose reads are bigger than a live consumer's.
 */
export function vectorPgPool(label: string, { batch = false } = {}): Pool {
  const vs = config.vectorSync;
  return createGuardedPgPool(
    {
      connectionString: config.postgres.connectionString,
      max: vs.pgPoolMax,
      connectionTimeoutMillis: vs.pgConnectionTimeoutMs,
      query_timeout: batch ? vs.pgBatchQueryTimeoutMs : vs.pgQueryTimeoutMs,
      keepAlive: true,
    },
    label,
    (message, err) => logger.error({ err }, message)
  );
}
