import type { NextApiRequest, NextApiResponse } from 'next';
import type client from 'prom-client';
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

const checkFns = {
  async write() {
    return !!(await dbWrite.$queryRawUnsafe('SELECT 1').catch((e) => {
      logError({ error: e, name: 'dbWrite', details: null });
      return false;
    }));
  },
  async read() {
    return !!(await dbRead.$queryRawUnsafe('SELECT 1').catch((e) => {
      logError({ error: e, name: 'dbRead', details: null });
      return false;
    }));
  },
  async pgWrite() {
    return !!(await pgDbWrite.query('SELECT 1').catch((e) => {
      logError({ error: e, name: 'pgWrite', details: null });
      return false;
    }));
  },
  async pgRead() {
    return !!(await pgDbRead.query('SELECT 1').catch((e) => {
      logError({ error: e, name: 'pgRead', details: null });
      return false;
    }));
  },
  async searchMetrics() {
    if (metricsSearchClient === null) return true;
    return await metricsSearchClient.isHealthy().catch((e) => {
      logError({ error: e, name: 'metricsSearch', details: null });
      return false;
    });
  },
  async redis() {
    try {
      // For cluster, we need to check if it's ready first
      const baseClient = redis as any;
      if (baseClient.isReady === false) {
        return false;
      }
      const res = await redis.ping();
      return res === 'PONG';
    } catch (e) {
      logError({ error: e as Error, name: 'redis', details: null });
      return false;
    }
  },
  async sysRedis() {
    return await sysRedis
      .ping()
      .then((res) => res === 'PONG')
      .catch((e) => {
        logError({ error: e, name: 'sysRedis', details: null });
        return false;
      });
  },
  async clickhouse() {
    return (
      (await clickhouse
        ?.ping()
        .then(({ success }) => success)
        .catch((e) => {
          logError({ error: e, name: 'clickhouse', details: null });
          return false;
        })) ?? true
    );
  },
  // async buzz() {
  //   return await pingBuzzService().catch((e) => {
  //     logError({ error: e, name: 'buzz', details: null });
  //     return false;
  //   });
  // },
} as const;
type CheckKey = keyof typeof checkFns;
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

  const disabledChecks = await getHealthcheckConfig(REDIS_SYS_KEYS.SYSTEM.DISABLED_HEALTHCHECKS);
  const resultsArray = await Promise.all(
    Object.entries(checkFns)
      .filter(([name]) => !disabledChecks.includes(name as CheckKey))
      .map(([name, fn]) =>
        timeoutAsyncFn(fn, false)
          .then((result) => {
            if (!result) counters[name as CheckKey]?.inc();
            return { [name]: result };
          })
          .catch(() => ({ [name]: false }))
      )
  );
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

function timeoutAsyncFn<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), env.HEALTHCHECK_TIMEOUT)),
  ]);
}

async function getHealthcheckConfig(key: string): Promise<CheckKey[]> {
  const value = await timeoutAsyncFn(
    () => sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, key),
    null
  );
  return JSON.parse(value ?? '[]') as CheckKey[];
}
