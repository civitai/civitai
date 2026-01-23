import type { NextApiRequest, NextApiResponse } from 'next';
import type client from 'prom-client';
import { commandOptions } from 'redis';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import { metricsSearchClient } from '~/server/meilisearch/client';
import { registerCounter } from '~/server/prom/client';
import { redis, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';

function logError({ error, name, details }: { error: Error; name: string; details: unknown }) {
  if (isProd) {
    logToAxiom({
      name: `health-check:${name}`,
      type: 'error',
      details,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }).catch();
  } else {
    console.log(`Failed to get a connection to ${name}`);
    console.error(error);
  }
}

// Type for cancellable check functions
type CancellableCheckFn = (signal: AbortSignal) => Promise<boolean>;

const checkFns: Record<string, CancellableCheckFn> = {
  // Prisma checks - use transaction timeout (Prisma doesn't support AbortSignal)
  // The statement_timeout limits query duration on the server side
  async write(signal: AbortSignal) {
    if (signal.aborted) return false;
    return !!(await dbWrite
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}`);
        return tx.$queryRawUnsafe(`SELECT 1`);
      })
      .catch((e) => {
        if (signal.aborted) return false;
        logError({ error: e, name: 'dbWrite', details: null });
        return false;
      }));
  },

  async read(signal: AbortSignal) {
    if (signal.aborted) return false;
    return !!(await dbRead
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}`);
        return tx.$queryRawUnsafe(`SELECT 1`);
      })
      .catch((e) => {
        if (signal.aborted) return false;
        logError({ error: e, name: 'dbRead', details: null });
        return false;
      }));
  },

  // pg checks - use simple query with statement_timeout
  // Note: cancellableQuery adds overhead (extra connection for pg_cancel_backend)
  // which isn't worth it for a simple SELECT 1. statement_timeout handles slow queries.
  async pgWrite(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      const result = await pgDbWrite.query(
        `SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}; SELECT 1`
      );
      if (signal.aborted) return false;
      return result.rowCount !== null && result.rowCount > 0;
    } catch (e) {
      if (signal.aborted) return false;
      logError({ error: e as Error, name: 'pgWrite', details: null });
      return false;
    }
  },

  async pgRead(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      const result = await pgDbRead.query(
        `SET LOCAL statement_timeout = ${env.HEALTHCHECK_TIMEOUT}; SELECT 1`
      );
      if (signal.aborted) return false;
      return result.rowCount !== null && result.rowCount > 0;
    } catch (e) {
      if (signal.aborted) return false;
      logError({ error: e as Error, name: 'pgRead', details: null });
      return false;
    }
  },

  async searchMetrics(signal: AbortSignal) {
    if (signal.aborted) return false;
    if (metricsSearchClient === null) return true;
    return await metricsSearchClient.isHealthy().catch((e) => {
      if (signal.aborted) return false;
      logError({ error: e, name: 'metricsSearch', details: null });
      return false;
    });
  },

  // Redis checks - use AbortSignal with commandOptions
  async redis(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      // For cluster, we need to check if it's ready first
      const baseClient = redis as any;
      if (baseClient.isReady === false) {
        return false;
      }
      // Use commandOptions with signal for cancellation
      const res = await (redis as any).ping(commandOptions({ signal }));
      return res === 'PONG';
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError') return false;
      logError({ error: e as Error, name: 'redis', details: null });
      return false;
    }
  },

  async sysRedis(signal: AbortSignal) {
    if (signal.aborted) return false;
    try {
      // Use commandOptions with signal for cancellation
      const res = await (sysRedis as any).ping(commandOptions({ signal }));
      return res === 'PONG';
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError') return false;
      logError({ error: e as Error, name: 'sysRedis', details: null });
      return false;
    }
  },

  // ClickHouse - use abort_signal for HTTP-level cancellation
  async clickhouse(signal: AbortSignal) {
    if (signal.aborted) return false;
    if (!clickhouse) return true;
    try {
      const { success } = await clickhouse.ping({ abort_signal: signal });
      return success;
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError') return false;
      logError({ error: e as Error, name: 'clickhouse', details: null });
      return false;
    }
  },
};
type CheckKey =
  | 'write'
  | 'read'
  | 'pgWrite'
  | 'pgRead'
  | 'searchMetrics'
  | 'redis'
  | 'sysRedis'
  | 'clickhouse';
const counters = (() =>
  [...Object.keys(checkFns), 'overall'].reduce((agg, name) => {
    agg[name as CheckKey] = registerCounter({
      name: `healthcheck_${name.toLowerCase()}`,
      help: `Healthcheck for ${name}`,
    });
    return agg;
  }, {} as Record<CheckKey | 'overall', client.Counter>))();

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);

  // Create AbortController for all health checks
  // This will be aborted when the client disconnects
  const abortController = new AbortController();
  const { signal } = abortController;

  // Abort all checks when client disconnects
  const onClose = () => {
    if (!isProd) console.log('Health check request cancelled (client disconnected)');
    abortController.abort();
  };
  res.on('close', onClose);

  const disabledChecks = await getHealthcheckConfig(REDIS_SYS_KEYS.SYSTEM.DISABLED_HEALTHCHECKS);

  // Check if already cancelled before starting the expensive health checks
  if (signal.aborted) {
    res.off('close', onClose);
    return;
  }

  const resultsArray = await Promise.all(
    Object.entries(checkFns)
      .filter(([name]) => !disabledChecks.includes(name as CheckKey))
      .map(([name, fn]) =>
        runCheckWithTimeout(fn, signal, env.HEALTHCHECK_TIMEOUT)
          .then((result) => {
            if (!result) counters[name as CheckKey]?.inc();
            return { [name]: result };
          })
          .catch(() => ({ [name]: false }))
      )
  );

  // Clean up the close listener
  res.off('close', onClose);

  // If cancelled, don't send response (connection is already closed)
  if (signal.aborted) {
    return;
  }

  const nonCriticalChecks = await getHealthcheckConfig(
    REDIS_SYS_KEYS.SYSTEM.NON_CRITICAL_HEALTHCHECKS
  );

  const healthy = resultsArray.every((result) => {
    const [key, value] = Object.entries(result)[0];
    return nonCriticalChecks.includes(key as CheckKey) || value;
  });
  if (!healthy) counters.overall?.inc();

  const results = resultsArray.reduce((agg, result) => ({ ...agg, ...result }), {}) as Record<
    CheckKey,
    boolean
  >;
  return res.status(healthy ? 200 : 500).json({
    podname,
    version: process.env.version,
    healthy,
    ...results,
  });
});

/**
 * Run a cancellable check function with timeout.
 * The signal is passed to the check function for proper cancellation support.
 */
async function runCheckWithTimeout(
  fn: CancellableCheckFn,
  signal: AbortSignal,
  timeout: number
): Promise<boolean> {
  if (signal.aborted) return false;

  // Create a combined signal that aborts on either:
  // 1. The parent signal (client disconnect)
  // 2. Timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

  // Create a combined abort handler
  const combinedController = new AbortController();
  const abortCombined = () => combinedController.abort();

  signal.addEventListener('abort', abortCombined, { once: true });
  timeoutController.signal.addEventListener('abort', abortCombined, { once: true });

  try {
    const result = await fn(combinedController.signal);
    return result;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', abortCombined);
  }
}

/**
 * Get healthcheck config from Redis with timeout
 */
async function getHealthcheckConfig(key: string): Promise<CheckKey[]> {
  try {
    const value = await Promise.race([
      sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, key),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), env.HEALTHCHECK_TIMEOUT)),
    ]);
    return JSON.parse(value ?? '[]') as CheckKey[];
  } catch {
    return [];
  }
}
