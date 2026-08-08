import type { NextApiResponse } from 'next';
import { EOL } from 'os';
import client from 'prom-client';
import { dbRead, dbWrite } from '~/server/db/client';
import { instrumentationRegistry } from '~/server/prom/client';
// Side-effect import: registers the challenge state gauges (collect()-based) on the default
// registry so they are present + scraped even before the first challenge op runs this session.
import '~/server/prom/challenge.metrics';
// Same reason (#3665): seeds all 12 (reason, surface) series of
// civitai_generation_model_substitutions_total at 0. Without this call the
// counter is registered only by the FIRST substitution on this pod, so
// `…{surface="api"}` read `no data` until then — indistinguishable from an
// unwired instrument, on a metric whose entire job is to be read as a gate.
//
// Next.js loads an API route lazily, so this runs on the first REQUEST to
// /api/metrics rather than at pod start — which is exactly soon enough: the
// only consumer is the scrape, and this module is what serves it, so the series
// are present in every response that could ever observe them.
import { ensureRegisterGenerationModelSubstitutionMetrics } from '~/server/metrics/generation-model-substitution.metrics';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

ensureRegisterGenerationModelSubstitutionMetrics();

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
  global.collectMetricsInitialized = true;
}

// NOTE: the instrumentation-registry metrics (eventloop long-task) intentionally do
// NOT set an app-side `podname` default label. Like every other custom app metric
// (trpc_procedure_duration, cache_hit_total, …) they get per-pod identity from
// Prometheus' scrape-time `pod` label (honorLabels: true in the ServiceMonitor); an
// app-emitted `podname` here would be redundant and inconsistent with the siblings.

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
