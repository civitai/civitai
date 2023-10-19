import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite, dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import osu from 'node-os-utils';
import { clickhouse } from '~/server/clickhouse/client';
import client from 'prom-client';

const checks = ['write', 'read', 'redis', 'clickhouse', 'overall'] as const;
const counters = (() =>
  checks.reduce((agg, name) => {
    agg[name] = new client.Counter({
      name: `healthcheck_${name.toLowerCase()}`,
      help: `Healthcheck for ${name}`,
    });
    return agg;
  }, {} as Record<(typeof checks)[number], client.Counter>))();

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);

  const writeDbCheck = !!(await dbWrite.user.findUnique({
    where: { id: -1 },
    select: { id: true },
  }));
  if (!writeDbCheck) counters.write.inc();

  const readDbCheck = !!(await dbRead.user.findUnique({
    where: { id: -1 },
    select: { id: true },
  }));
  if (!readDbCheck) counters.read.inc();

  const redisCheck = await redis
    .ping()
    .then((res) => res === 'PONG')
    .catch(() => false);
  if (!redisCheck) counters.redis.inc();

  const clickhouseCheck =
    (await clickhouse
      ?.ping()
      .then(({ success }) => success)
      .catch(() => false)) ?? true;
  if (!clickhouseCheck) counters.clickhouse.inc();

  const healthy = writeDbCheck && readDbCheck && redisCheck && clickhouseCheck;
  if (!healthy) counters.overall.inc();
  // const includeCPUCheck = await redis.get(`system:health-check:include-cpu-check`);
  // let freeCPU: number | undefined;
  // if (includeCPUCheck) {
  //   const { requiredFreeCPU, interval } = JSON.parse(includeCPUCheck);
  //   freeCPU = await osu.cpu.free(interval);
  //   healthy = healthy && freeCPU > requiredFreeCPU;
  // }

  return res.status(healthy ? 200 : 500).json({
    podname,
    healthy: healthy,
    writeDb: writeDbCheck,
    readDb: readDbCheck,
    redis: redisCheck,
    clickhouse: clickhouseCheck,
    // freeCPU,
  });
});
