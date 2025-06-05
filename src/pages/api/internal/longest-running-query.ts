import type { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const [result] = await dbWrite.$queryRaw<any[]>`
    SELECT
      a.pid,
      a.application_name,
      floor(EXTRACT(EPOCH FROM (NOW() - query_start)))::int AS duration,
      a.query,
      l.locktype,
      l.mode,
      CAST(l.relation::regclass as text) AS locked_table,
      l.granted
    FROM pg_stat_activity a
    JOIN pg_locks l ON a.pid = l.pid
    WHERE
      a.state = 'active'
      AND l.granted = true
    ORDER BY
      duration DESC
    LIMIT 1;
  `;

  return res.status(200).json(result);
});
