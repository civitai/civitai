import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite, dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import { clickhouse } from '~/server/clickhouse/client';
import { pingBuzzService } from '~/server/services/buzz.service';
import { env } from '~/env/server.mjs';
import { pgDbWrite } from '~/server/db/pgDb';
import { metricsSearchClient } from '~/server/meilisearch/client';
import { registerCounter } from '~/server/prom/client';
import client from 'prom-client';

const checkFns = {
  async write() {
    return !!(await dbWrite.user.findUnique({
      where: { id: -1 },
      select: { id: true },
    }));
  },
  async read() {
    return !!(await dbRead.user.findUnique({
      where: { id: -1 },
      select: { id: true },
    }));
  },
  async pgWrite() {
    return !!(await pgDbWrite.query('SELECT 1'));
  },
  async pgRead() {
    return !!(await pgDbWrite.query('SELECT 1'));
  },
  async searchMetrics() {
    if (metricsSearchClient === null) return true;
    return await metricsSearchClient.isHealthy();
  },
  async redis() {
    return await redis
      .ping()
      .then((res) => res === 'PONG')
      .catch(() => false);
  },
  async clickhouse() {
    return (
      (await clickhouse
        ?.ping()
        .then(({ success }) => success)
        .catch(() => false)) ?? true
    );
  },
  async buzz() {
    return await pingBuzzService();
  },
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

  const disabledChecks = JSON.parse(
    (await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.SYSTEM.DISABLED_HEALTHCHECKS)) ?? '[]'
  ) as CheckKey[];
  const resultsArray = await Promise.all(
    Object.entries(checkFns)
      .filter(([name]) => !disabledChecks.includes(name as CheckKey))
      .map(([name, fn]) =>
        timeoutAsyncFn(fn).then((result) => {
          if (!result) counters[name as CheckKey].inc();
          return { [name]: result };
        })
      )
  );
  const nonCriticalChecks = JSON.parse(
    (await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.SYSTEM.NON_CRITICAL_HEALTHCHECKS)) ??
      '[]'
  ) as CheckKey[];

  const healthy = resultsArray.every((result) => {
    const [key, value] = Object.entries(result)[0];
    return nonCriticalChecks.includes(key as CheckKey) || value;
  });
  if (!healthy) counters.overall.inc();

  const results = resultsArray.reduce((agg, result) => ({ ...agg, ...result }), {}) as Record<
    CheckKey,
    boolean
  >;
  return res.status(healthy ? 200 : 500).json({
    podname,
    healthy,
    ...results,
  });
});

function timeoutAsyncFn(fn: () => Promise<boolean>) {
  return Promise.race([
    fn(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), env.HEALTHCHECK_TIMEOUT)),
  ]);
}
