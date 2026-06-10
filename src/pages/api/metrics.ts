import type { NextApiResponse } from 'next';
import { EOL } from 'os';
import client from 'prom-client';
import { dbRead, dbWrite } from '~/server/db/client';
import { instrumentationRegistry } from '~/server/prom/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const labels: Record<string, string> = {};
if (process.env.PODNAME) {
  labels.podname = process.env.PODNAME;
}

declare global {
  // eslint-disable-next-line no-var
  var collectMetricsInitialized: boolean;
}

if (!global.collectMetricsInitialized) {
  client.collectDefaultMetrics({
    register: client.register,
    labels,
  });
  // Apply the same default labels (e.g. podname) to the cross-graph instrumentation
  // registry so its series (eventloop long-task metrics) carry podname like every
  // other app metric — otherwise per-pod attribution on those series is lost.
  instrumentationRegistry.setDefaultLabels(labels);
  global.collectMetricsInitialized = true;
}

const handler = WebhookEndpoint(async (_, res: NextApiResponse) => {
  const metrics = await client.register.metrics();

  // Metrics emitted from the instrumentation webpack graph (e.g. the event-loop
  // long-task detector) live in a separate `client.register` than this request-graph
  // one, so they must be scraped from the cross-graph shared `instrumentationRegistry`
  // explicitly. See the WHY note on instrumentationRegistry in src/server/prom/client.ts.
  const instrumentationMetrics = await instrumentationRegistry.metrics();

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

  const result = [metrics, instrumentationMetrics, readMetrics, writeMetrics].join(EOL);

  res.setHeader('Content-type', client.register.contentType);
  res.send(result);
});

export default handler;
