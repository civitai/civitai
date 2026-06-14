import client from 'prom-client';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Unsampled per-route APP-EMITTED 5xx attribution counter
// ---------------------------------------------------------------------------
//
// WHY: there is no trustworthy way to attribute the app-500 floor to routes.
//  - OTEL spanmetrics are HEAD-sampled (TraceIdRatioBasedSampler @ 0.1 in
//    instrumentation.node.ts) AND their span_name is cardinality-blown by raw
//    scanner URLs (`GET /&ved=...google...`, ~11k series for one service).
//  - tRPC/API errors only reach Axiom, which isn't queryable in Prometheus.
//
// SCOPE (important): this counts 5xx that the APP ITSELF emits — i.e. the ~500
// class. Edge/Traefik-generated 502/504 (event-loop pin, liveness SIGKILL,
// gateway timeout on a hung upstream) never run app code, so a `finish` listener
// can't see them and they are NOT counted here. Use the Traefik
// `traefik_service_requests_total{code=~"5.."}` series as the full 5xx floor
// denominator; this counter is the per-route source of truth for the app-500
// slice of it. See datapacket-talos
// claudedocs/dp-prod-error-latency-slo-characterization-2026-06-12.md (O1).
//
// HOT PATH: this codebase is main-thread-CPU sensitive (Redis/Prisma OTEL spans
// were removed for exactly this reason). The only steady-state cost added per
// request is registering one `res.once('finish')` closure + an integer compare;
// the route-normalization below runs ONLY on 5xx responses (~0.3% of traffic).
//
// INVARIANT: import this module ONLY from the request webpack graph (API routes /
// pages). prom-client keeps a per-graph default registry, and `/api/metrics`
// scrapes the request graph's. If an `instrumentation.*` import ever pulled this
// into the instrumentation graph first, the counter would register into the wrong
// registry and silently stop being scraped (the PR #2451 class of bug).

const NAME = 'civitai_app_http_errors_total';

declare global {
  // eslint-disable-next-line no-var
  var __civitaiHttpErrorCounter: client.Counter<string> | undefined;
}

// Pin on globalThis so HMR re-evals / a second request-graph eval reuse the one
// instance instead of throwing prom-client's duplicate-registration error (same
// trap documented for instrumentationRegistry in src/server/prom/client.ts). The
// `??` short-circuits BEFORE `new client.Counter`, so the constructor runs once.
export const httpErrorCounter: client.Counter<string> =
  globalThis.__civitaiHttpErrorCounter ??
  (globalThis.__civitaiHttpErrorCounter = new client.Counter({
    name: NAME,
    help: 'Count of APP-EMITTED 5xx responses by normalized route, status, kind. UNSAMPLED. kind=api increments per RESPONSE (once per 5xx); kind=trpc increments per PROCEDURE-error (a batched request can increment several times) — account for this when summing. EDGE-generated 502/504 (event-loop pin, liveness SIGKILL, gateway timeout) are NOT counted: the app never runs for those — use Traefik code=~"5.." for the full floor. App-THROWN 5xx (incl. a TRPCError mapping to 502/503/504) ARE counted. COVERAGE: only routes using the 6 endpoint-helper wrappers (Public/Authed/MixedAuth/Mod/Partner/TokenSecured→withApiMetrics) + tRPC are instrumented; bare custom handlers — notably the payment webhooks (stripe/paddle/coinbase/nowpayments/tipalti/emerchantpay), auth/[...nextauth], oauth/*, and upload/* — are NOT, so their 5xx show in Traefik only. Treat this as the app-emitted 5xx slice for WRAPPED routes, not the whole app.',
    labelNames: ['route', 'status', 'kind'],
  }));

type Kind = 'api' | 'trpc';

// ---------------------------------------------------------------------------
// Bounded distinct-route tracking (hard cardinality cap, grow-only, per kind)
// ---------------------------------------------------------------------------
//
// Sized to cover the real route surface so legit routes are NEVER lost to
// <overflow> — ~203 wrapped Pages-API route files and ~870 tRPC procedures. With
// route params normalized and query-string keys excluded (see reconstructApiRoute),
// nothing user-controlled can inflate this; only genuinely novel real routes
// beyond the budget collapse. Per-kind so a tRPC error storm can't starve the API
// budget (or vice-versa).
const ROUTE_BUDGET: Record<Kind, number> = { api: 400, trpc: 1000 };
const seenByKind: Record<Kind, Set<string>> = { api: new Set(), trpc: new Set() };

function bounded(route: string, kind: Kind): string {
  const seen = seenByKind[kind];
  if (seen.has(route)) return route;
  if (seen.size >= ROUTE_BUDGET[kind]) return `${kind} <overflow>`;
  seen.add(route);
  return route;
}

// ---------------------------------------------------------------------------
// Route normalization (runs only on 5xx)
// ---------------------------------------------------------------------------

function collapseSegment(seg: string): string {
  if (/^\d+$/.test(seg)) return ':id';
  // 8+ hex (was 16+) so short hashes — e.g. the 10-char AutoV2 model hash — that
  // slip past `[key]` replacement on a route-param/query-key collision collapse to
  // :hash instead of leaking verbatim into a label. No static API route segment is
  // 8+ pure-hex, so legit routes are unaffected.
  if (/^[0-9a-f]{8,}$/i.test(seg)) return ':hash';
  if (seg.length > 40) return ':long';
  // Defense-in-depth (M2): a leftover segment here SHOULD be a static route word —
  // matched routes reach this code only for their literal path parts; dynamic
  // segments are req.query route params and are replaced upstream by [key]. But
  // guard against an un-replaced opaque token (e.g. a percent-encoding mismatch
  // between req.url and the decoded req.query value) leaking verbatim into a label:
  if (/[^a-zA-Z0-9._-]/.test(seg)) return ':param'; // query/junk chars
  if (seg.length >= 16 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && /\d/.test(seg)) return ':token';
  return seg;
}

function reconstructApiRoute(req: NextApiRequest): string {
  const method = (req.method ?? 'GET').toUpperCase();
  let pathname: string;
  let queryStringKeys: Set<string>;
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    pathname = url.pathname;
    queryStringKeys = new Set(url.searchParams.keys());
  } catch {
    return `${method} <bad-url>`;
  }
  if (!pathname.startsWith('/api/')) return `${method} <non-api>`;

  // Next merges the dynamic ROUTE params and the query string into a single
  // req.query. The route params are exactly the keys NOT present in the URL's
  // query string. We must only value-match against route params: matching against
  // query-string values is attacker-controllable — appending `?j=v1` would rewrite
  // the static `/v1` segment, splitting/poisoning route labels and exhausting the
  // cardinality budget. Build an exact value→[key] map from route params only.
  const query = req.query ?? {};
  const valueToParam = new Map<string, string>();
  for (const key of Object.keys(query)) {
    if (queryStringKeys.has(key)) continue; // query-string param — not a route param
    const val = query[key];
    const values = Array.isArray(val) ? val : [val];
    for (const v of values) {
      if (typeof v === 'string' && v.length >= 1) valueToParam.set(v, `[${key}]`);
    }
  }

  // Replace by EXACT whole-segment equality (no substring `includes/split`).
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((seg) => valueToParam.get(seg) ?? collapseSegment(seg))
    .slice(0, 6);
  return `${method} /${segments.join('/')}`;
}

/**
 * Attach a one-shot `finish` listener that records the response as a 5xx error
 * iff its final status is >= 500. Catches an app-emitted 5xx no matter how it was
 * produced (handleEndpointError, a direct `res.status(500)`, or an uncaught throw
 * Next turns into a default 500). NOTE: `finish` only fires when the app completes
 * the response — client-aborted / hung / edge-timed-out requests (the 504 set) do
 * not run this, by design (see the SCOPE note above). A metric failure can never
 * break the response.
 */
export function instrumentApiResponse(req: NextApiRequest, res: NextApiResponse): void {
  // Honor the "can never break the response" contract for ALL inputs: a real
  // Node ServerResponse is always an EventEmitter, but a handler unit-test may
  // pass a partial `res` double without `.once` (and a null res is cheap to
  // guard too). No-op rather than throw — worst case is a missing metric, never
  // a broken handler. NOTE: this also silently no-ops on the Edge runtime (a Web
  // Response has no `.once`); there are no edge API routes today, but a future
  // edge route would need different instrumentation — a finish-listener can't
  // see it (same class as the edge-502/504 SCOPE caveat above).
  if (!res || typeof res.once !== 'function') return;
  res.once('finish', () => {
    const status = res.statusCode;
    if (status < 500) return; // hot-path: 2xx/3xx/4xx do zero normalization work
    try {
      const route = bounded(reconstructApiRoute(req), 'api');
      httpErrorCounter.inc({ route, status: String(status), kind: 'api' });
    } catch {
      /* never throw from telemetry */
    }
  });
}

/**
 * Record a tRPC error as a 5xx by procedure path. The procedure path is already a
 * clean, low-cardinality label (e.g. `image.getInfinite`). Only genuine TRPCErrors
 * that map to >= 500 count — 4xx-class errors and any non-TRPCError cause passed by
 * tRPC's streaming/jsonl error paths are ignored (the latter would otherwise be
 * miscounted as 500 by getHTTPStatusCodeFromError's undefined→500 fallback).
 *
 * KNOWN DIVERGENCE FROM TRAEFIK on the tRPC path: client aborts are skipped here
 * (see the isClientAbortError guard in the tRPC onError), but tRPC's onError can't
 * set an HTTP status, so the aborted procedure still returns 500 to the edge and
 * Traefik DOES count it in `code=~"5.."`. So for aborts, kind=trpc reads slightly
 * LOWER than Traefik (~0.07/s) — that's intentional, not a counter bug. The REST
 * paths don't diverge (they emit a real 499). Don't "reconcile" this away.
 */
export function recordTrpcError(error: unknown, path?: string): void {
  try {
    if (!(error instanceof TRPCError)) return;
    const status = getHTTPStatusCodeFromError(error);
    if (status < 500) return;
    const route = bounded(`trpc/${path ?? 'unknown'}`, 'trpc');
    httpErrorCounter.inc({ route, status: String(status), kind: 'trpc' });
  } catch {
    /* never throw from telemetry */
  }
}
