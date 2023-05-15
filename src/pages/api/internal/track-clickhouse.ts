import { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { clickhouse } from '~/server/clickhouse/client';
import { z } from 'zod';

const trackSchema = z.object({
  table: z.string(),
});

export default WebhookEndpoint(async function trackClickhouse(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { table } = trackSchema.parse(req.query);
  if (!table) {
    return res.status(400).json({
      error: 'Missing table name',
    });
  }

  const data = JSON.parse(req.body);

  if (!data) {
    return res.status(400).json({
      error: 'Missing body',
    });
  }

  if (!clickhouse) {
    return res.status(500).json({
      error: 'Clickhouse is not enabled',
    });
  }
  if (table) res.status(202).end();

  await clickhouse?.insert({
    table: table,
    values: [data],
    format: 'JSONEachRow',
  });
});
