import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

type Row = { application_name: string; duration: number; query: string };

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const [result] = await dbWrite.$queryRaw<Row[]>`
    SELECT
      application_name,
      floor(EXTRACT(EPOCH FROM (NOW() - query_start))) AS duration,
      query
    FROM
      pg_stat_activity
    WHERE
      state = 'active'
      AND datname = 'civitai'
      ORDER BY 1 DESC
      LIMIT 1;
  `;

  return res.status(200).json(result);
});
