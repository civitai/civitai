import client from 'prom-client';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Unsampled per-route 5xx attribution counter
// ---------------------------------------------------------------------------
//
// WHY: there is no trustworthy way to attribute the 5xx floor to routes today.
//  - OTEL spanmetrics are HEAD-sampled (TraceIdRatioBasedSampler @ 0.1 in
//    instrumentation.node.ts) AND their span_name is polluted by raw scanner URLs
//    (`GET /&ved=...google...`), so the per-route 500 ranking is both 10%-sampled
//    and cardinality-blown (~11k series for one service).
//  - tRPC/API errors go to Axiom, which isn't queryable in Prometheus for an SLO.
//
// This counter is the unsampled source of truth for "which routes drive the 5xx
// floor". It runs in the request path (NOT via a span processor), so trace
// sampling does not apply — every 5xx is counted. See the decomposition in
// datapacket-talos: claudedocs/dp-prod-error-latency-slo-characterization-2026-06-12.md
//
// HOT PATH: this codebase is main-thread-CPU sensitive (Redis/Prisma OTEL spans
// were removed for exactly this reason). The only steady-state cost added per
// request is registering one `res.once('finish')` closure + an integer compare;
// the route-normalization work below runs ONLY on 5xx responses (~0.3% of
// traffic), never on the 2xx hot path.

const NAME = 'civitai_app_http_errors_total';

declare global {
  // eslint-disable-next-line no-var
  var __civitaiHttpErrorCounter: client.Counter<string> | undefined;
}

// Request-graph metric → default `client.register`, which `/api/metrics` scrapes.
// Pin on globalThis so HMR re-evals / a second webpack graph reuse the one
// instance instead of throwing prom-client's duplicate-registration error (same
// trap documented for instrumentationRegistry in src/server/prom/client.ts).
export const httpErrorCounter: client.Counter<string> =
  globalThis.__civitaiHttpErrorCounter ??
  (globalThis.__civitaiHttpErrorCounter = new client.Counter({
    name: NAME,
    help: 'Count of 5xx HTTP responses by normalized route, status code, and kind (api|trpc). Unsampled; source of truth for per-route 5xx SLO attribution.',
    labelNames: ['route', 'status', 'kind'],
  }));

// ---------------------------------------------------------------------------
// Route normalization (runs only on 5xx)
// ---------------------------------------------------------------------------
//
// We can't read the route from the OTEL span (90% are non-recording under head
// sampling). Instead reconstruct the Next route PATTERN from the request: Next
// populates `req.query` with the dynamic route params, so replacing each param
// VALUE in the path with `[key]` yields the file-route pattern
// (e.g. `/api/download/training/[modelVersionId]`). A structural pass collapses
// anything left (numeric ids, hashes, junk segments), and a hard distinct-label
// cap is the final backstop so no input can ever blow up cardinality.

const SEEN = new Set<string>();
const MAX_DISTINCT_ROUTES = 300;

function structuralCollapse(segment: string): string {
  if (/^\d+$/.test(segment)) return ':id';
  if (/^[0-9a-f]{16,}$/i.test(segment)) return ':hash';
  if (segment.length > 48) return ':long';
  if (/[^a-zA-Z0-9._[\]-]/.test(segment)) return ':param'; // contains query/junk chars
  return segment;
}

function reconstructApiRoute(req: NextApiRequest): string {
  const method = (req.method ?? 'GET').toUpperCase();
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://x').pathname;
  } catch {
    return `${method} <bad-url>`;
  }
  if (!path.startsWith('/api/')) return `${method} <non-api>`;

  // Replace dynamic route-param values (whole segments only) with [key].
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    const val = query[key];
    const values = Array.isArray(val) ? val : [val];
    for (const v of values) {
      if (typeof v === 'string' && v.length >= 1 && path.includes(`/${v}`)) {
        path = path.split(`/${v}`).join(`/[${key}]`);
      }
    }
  }

  const segments = path.split('/').filter(Boolean).map(structuralCollapse).slice(0, 6);
  return `${method} /${segments.join('/')}`;
}

// Hard cardinality backstop: once we've observed MAX_DISTINCT_ROUTES patterns,
// collapse any new one to `<overflow>` so a novel garbage stream can never grow
// the series count without bound.
function bounded(route: string, kindPrefix: string): string {
  if (SEEN.has(route)) return route;
  if (SEEN.size >= MAX_DISTINCT_ROUTES) return `${kindPrefix} <overflow>`;
  SEEN.add(route);
  return route;
}

/**
 * Attach a one-shot `finish` listener that records the response as a 5xx error
 * iff its final status is >= 500. Catches the error no matter how it was produced
 * (handleEndpointError, a direct `res.status(500)`, or an uncaught throw Next
 * turns into a default 500). Safe to call once per request from the endpoint
 * wrappers; a metric failure can never break the response.
 */
export function instrumentApiResponse(req: NextApiRequest, res: NextApiResponse): void {
  res.once('finish', () => {
    const status = res.statusCode;
    if (status < 500) return; // hot-path: 2xx/3xx/4xx do zero normalization work
    try {
      const route = bounded(reconstructApiRoute(req), (req.method ?? 'GET').toUpperCase());
      httpErrorCounter.inc({ route, status: String(status), kind: 'api' });
    } catch {
      /* never throw from telemetry */
    }
  });
}

/**
 * Record a tRPC error as a 5xx by procedure path. The procedure path is already a
 * clean, low-cardinality label (e.g. `image.getInfinite`). 4xx-class tRPC errors
 * (BAD_REQUEST/NOT_FOUND/etc.) are ignored — only server-fault 5xx count toward
 * the SLO.
 */
export function recordTrpcError(error: TRPCError, path?: string): void {
  try {
    const status = getHTTPStatusCodeFromError(error);
    if (status < 500) return;
    const route = bounded(`trpc/${path ?? 'unknown'}`, 'trpc');
    httpErrorCounter.inc({ route, status: String(status), kind: 'trpc' });
  } catch {
    /* never throw from telemetry */
  }
}
