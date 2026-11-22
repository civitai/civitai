import type { Pool } from 'pg';
import { config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';

/** Every vector-sync process's pool: each query, and each wait for a free client, is bounded. */
export function vectorPgPool(label: string): Pool {
  const vs = config.vectorSync;
  return createGuardedPgPool(
    {
      connectionString: config.postgres.connectionString,
      max: vs.pgPoolMax,
      connectionTimeoutMillis: vs.pgConnectionTimeoutMs,
      query_timeout: vs.pgQueryTimeoutMs,
      keepAlive: true,
    },
    label,
    (message, err) => logger.error({ err }, message)
  );
}
