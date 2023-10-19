import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite, dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import osu from 'node-os-utils';
import { clickhouse } from '~/server/clickhouse/client';

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);

  const writeDbCheck = !!(await dbWrite.user.findUnique({
    where: { id: -1 },
    select: { id: true },
  }));
  const readDbCheck = !!(await dbRead.user.findUnique({ where: { id: -1 }, select: { id: true } }));

  const redisCheck = await redis
    .ping()
    .then((res) => res === 'PONG')
    .catch(() => false);

  const clickhouseCheck =
    (await clickhouse
      ?.ping()
      .then(({ success }) => success)
      .catch(() => false)) ?? true;

  const healthy = writeDbCheck && readDbCheck && redisCheck && clickhouseCheck;
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
