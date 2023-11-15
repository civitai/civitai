import { NextApiResponse } from 'next';
import client from 'prom-client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { EOL } from 'os';

const labels: Record<string, string> = {};
if (process.env.PODNAME) {
  labels.podname = process.env.PODNAME;
}

client.collectDefaultMetrics({
  register: client.register,
  labels,
});

const handler = WebhookEndpoint(async (_, res: NextApiResponse) => {
  const metrics = await client.register.metrics();

  const readMetrics = await dbRead.$metrics.prometheus({
    globalLabels: {
      ...labels,
      type: 'read',
    },
  });

  const writeMetrics = await dbWrite.$metrics.prometheus({
    globalLabels: {
      ...labels,
      type: 'write',
    },
  });

  const result = [metrics, readMetrics, writeMetrics].join(EOL);

  res.setHeader('Content-type', client.register.contentType);
  res.send(result);
});

export default handler;
