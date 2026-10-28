import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// Route-side 451 counter for `/api/trpc`
// ---------------------------------------------------------------------------
//
// `/api/trpc` is not in the proxy matcher, so the tRPC route answers the region block itself
// (`applyApiRequestPolicy`). This counts those 451s. It began as one of two soak counters for the
// `trpc-skip-proxy-middleware` flag; the other (`civitai_app_trpc_proxy_skipped_total`) counted
// proxy passthroughs and went away with the proxy's tRPC branch. The series name is unchanged so
// existing queries keep working.
//
// No labels: one series, by construction.
//
// Registered on `instrumentationRegistry` (pinned on globalThis and merged into the `/api/metrics`
// scrape), as it was when the proxy bundle also wrote to this module. Only the route imports it
// now; keeping the registry leaves the scraped series exactly as it was.

const ROUTE_REGION_BLOCKS = 'civitai_app_trpc_route_region_blocks_total';

const routeRegionBlocksCounter = registerInstrumentationMetric(
  ROUTE_REGION_BLOCKS,
  () =>
    new client.Counter({
      name: ROUTE_REGION_BLOCKS,
      help: 'Region-blocked (451) responses answered by the tRPC route itself (/api/trpc is not in the proxy matcher). UNSAMPLED.',
      registers: [instrumentationRegistry],
    })
);

/** Never throws. */
export function recordTrpcRouteRegionBlock(): void {
  try {
    routeRegionBlocksCounter.inc();
  } catch {
    /* never throw from telemetry */
  }
}
