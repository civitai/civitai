import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// ---------------------------------------------------------------------------
// Soak counters for the `trpc-skip-proxy-middleware` flag
// ---------------------------------------------------------------------------
//
// With the flag ON the proxy hands `/api/trpc` straight through and the tRPC route applies the API
// policy itself (`applyApiRequestPolicy`). These two counters are what the soak reads:
//   - `..._proxy_skipped_total` moving says the flag is really ON in this process;
//   - `..._route_region_blocks_total` moving says the 451 for a blocked region is now answered by
//     the route (with the flag OFF the proxy answers it, so the route never sees the request).
//
// No labels: one series each, by construction.
//
// 🔴 REGISTERED ON `instrumentationRegistry`, NOT THE DEFAULT REGISTRY. The proxy is compiled into
// its own bundle with its own copy of prom-client's default registry, which `/api/metrics` never
// scrapes. `instrumentationRegistry` is pinned on globalThis and merged into the scrape, so both the
// proxy and the route reach the same series. Import this module from `@civitai/telemetry/client`
// only (never `~/server/prom/client`, which pulls the database clients into the proxy bundle).

const PROXY_SKIPPED = 'civitai_app_trpc_proxy_skipped_total';
const ROUTE_REGION_BLOCKS = 'civitai_app_trpc_route_region_blocks_total';

const proxySkippedCounter = registerInstrumentationMetric(
  PROXY_SKIPPED,
  () =>
    new client.Counter({
      name: PROXY_SKIPPED,
      help: 'tRPC requests the proxy passed straight through because trpc-skip-proxy-middleware is ON (the route applied the API policy itself). UNSAMPLED.',
      registers: [instrumentationRegistry],
    })
);

const routeRegionBlocksCounter = registerInstrumentationMetric(
  ROUTE_REGION_BLOCKS,
  () =>
    new client.Counter({
      name: ROUTE_REGION_BLOCKS,
      help: 'Region-blocked (451) API responses answered by the tRPC route itself rather than the proxy. Non-zero only while trpc-skip-proxy-middleware is ON. UNSAMPLED.',
      registers: [instrumentationRegistry],
    })
);

/** Never throws. */
export function recordTrpcProxySkipped(): void {
  try {
    proxySkippedCounter.inc();
  } catch {
    /* never throw from telemetry */
  }
}

/** Never throws. */
export function recordTrpcRouteRegionBlock(): void {
  try {
    routeRegionBlocksCounter.inc();
  } catch {
    /* never throw from telemetry */
  }
}
