import type { NextApiResponse } from 'next';
import { EOL } from 'os';
import client from 'prom-client';
import { dbRead, dbWrite } from '~/server/db/client';
import { instrumentationRegistry } from '~/server/prom/client';
// Side-effect import: registers the challenge state gauges (collect()-based) on the default
// registry so they are present + scraped even before the first challenge op runs this session.
import '~/server/prom/challenge.metrics';
// Side-effect import: registers the session-resolution metrics, including the UNLABELLED
// session_legacy_decode_total. Unlabelled counters only carry their "healthy is an observable 0" meaning if
// the module is loaded — otherwise an absent series looks like a dead code path rather than an unloaded one,
// which is the exact ambiguity that counter exists to remove.
import '~/server/auth/session-metrics';
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
// Same reason again (#3930): seeds all 8 (outcome, mode) series of
// bitdex_primary_result_total and all 6 reasons of bitdex_query_failures_total
// at 0. `fallback_error` is the series the issue is about, and it is expected to
// read zero on a healthy day — so an absent series and a healthy zero MUST be
// distinguishable, or the metric answers nothing. The older bitdex_shadow_*
// counters skipped this and are `no data` on a live read today.
import { ensureRegisterBitdexFeedServeMetrics } from '~/server/metrics/bitdex-feed-serve.metrics';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

ensureRegisterGenerationModelSubstitutionMetrics();
ensureRegisterBitdexFeedServeMetrics();

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

// `$metrics` is a Prisma PREVIEW feature (previewFeatures = ["metrics"] in
// schema.full.prisma), so it is one schema/engine change away from throwing —
// under the queryCompiler engine, for instance, its implementation is a bare
// `throw new Error("Method not implemented.")`. Awaiting it unguarded put the
// ENTIRE scrape behind it: one Prisma failure and this endpoint 500s, taking
// default metrics, the instrumentation registry, and every seeded counter above
// with it. Degrade to losing just the Prisma series instead.
const PRISMA_METRICS_FAILURES = 'prisma_metrics_scrape_failures_total';
const prismaMetricsFailures =
  (client.register.getSingleMetric(PRISMA_METRICS_FAILURES) as client.Counter<'type'>) ??
  new client.Counter({
    name: PRISMA_METRICS_FAILURES,
    help: "Scrapes where PrismaClient.$metrics.prometheus() threw, so that client's series are absent from the response.",
    labelNames: ['type'] as const,
    registers: [client.register],
  });

// Seeded so a healthy pod reports an observable 0 rather than `no data` — an
// absent series here is indistinguishable from a scrape that never checked.
//
// Guarded because this runs at MODULE SCOPE: the `as` cast above is unchecked,
// so if this name is ever registered elsewhere with a different type or
// labelset, `inc` throws while the route module is evaluating and 500s the
// whole scrape — the exact failure the rest of this block exists to prevent.
try {
  prismaMetricsFailures.inc({ type: 'read' }, 0);
  prismaMetricsFailures.inc({ type: 'write' }, 0);
} catch {
  // Seeding is a readability nicety; losing it must not cost the scrape.
}

async function collectPrismaMetrics(db: typeof dbRead | typeof dbWrite, type: 'read' | 'write') {
  try {
    return await db.$metrics.prometheus({ globalLabels: { ...labels, type } });
  } catch {
    prismaMetricsFailures.inc({ type });
    return '';
  }
}

const handler = WebhookEndpoint(async (_, res: NextApiResponse) => {
  const metrics = await client.register.metrics();

  // Metrics emitted from the instrumentation webpack graph (e.g. the event-loop
  // long-task detector) live in a separate `client.register` than this request-graph
  // one, so they must be scraped from the cross-graph shared `instrumentationRegistry`
  // explicitly. See the WHY note on instrumentationRegistry in src/server/prom/client.ts.
  const instrumentationMetrics = await instrumentationRegistry.metrics();

  const readMetrics = await collectPrismaMetrics(dbRead, 'read');
  const writeMetrics = await collectPrismaMetrics(dbWrite, 'write');

  const result = [metrics, instrumentationMetrics, readMetrics, writeMetrics].join(EOL);

  res.setHeader('Content-type', client.register.contentType);
  res.send(result);
});

export default handler;
