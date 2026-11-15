import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import client from 'prom-client';
import type { Histogram } from 'prom-client';
import type { RequestMeta } from 'next/dist/server/request-meta';
import {
  PROM_PREFIX,
  TRPC_PROCEDURE_DURATION_BUCKETS,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { apiRouteLabel } from '~/server/utils/page-routes';

// ---------------------------------------------------------------------------
// Per-route request histogram for every pages-API route (`src/pages/api/**`)
// ---------------------------------------------------------------------------
//
// WHY: tRPC procedures have `civitai_app_trpc_procedure_duration_seconds{path}`, but the REST routes
// had no per-route request count, so their share of server CPU could not be attributed. This counts
// and times every request to a pages-API route, labelled by the route PATTERN.
//
// WHERE IT HOOKS: `http.Server.prototype.emit('request')`, not an endpoint wrapper. The routes use
// a dozen different wrappers (endpoint-helpers, defineModeratorEndpoint, withBlockScope, bare
// withAxiom, bare handlers such as every /api/auth/* route), so a wrapper hook covers only part of
// them. The server sees every request, on both servers this app runs under: `next start` and the
// standalone server (scripts/trpc-server/server.cjs), which is also a plain `http.Server`. The
// response's `close` event fires exactly once per response, whether it finished or the client went
// away, so each request is observed exactly once — including one whose handler threw (Next answers
// it with a 500) and one that never answered (`status_class="aborted"`).
//
// WHERE THE ROUTE COMES FROM, read when the response closes (by then the route has been resolved):
//   - under Next, the route match Next stores on the request (`match.definition.page`, the same
//     pattern its own OTel span names use);
//   - under the standalone server, the page it matched, which it stores under
//     `STANDALONE_API_ROUTE_PAGE_KEY` because it calls route modules without Next's router.
// Either way the value must be a key of the build's pages-manifest (`apiRouteLabel`), or it labels
// `other`. So the label set is the build's API routes plus `other`: a URL never reaches a label.
//
// COST: requests whose URL does not start with `/api/` pay one string compare. API requests pay one
// `performance.now()` and one `close` listener; the label lookups run once, when the response
// closes, and do no async work.
//
// DARK BY DEFAULT: nothing is installed unless API_ROUTE_METRICS=true, the same opt-in shape as
// TRPC_PROCEDURE_METRICS, because a histogram per route x method x status class is a large series
// count per pod. Enable it on the pools being measured.

export const API_ROUTE_DURATION_METRIC = PROM_PREFIX + 'api_route_duration_seconds';

/** The `Symbol.for` key under which the standalone server stores the page it matched on `req`. */
export const STANDALONE_API_ROUTE_PAGE_KEY = 'civitai.standalone.apiRoutePage';
const STANDALONE_API_ROUTE_PAGE = Symbol.for(STANDALONE_API_ROUTE_PAGE_KEY);

/** Next's request-meta key (`NEXT_REQUEST_META` in next/dist/server/request-meta). */
export const NEXT_REQUEST_META = Symbol.for('NextInternalRequestMeta');

export const API_ROUTE_OTHER = 'other';
export const STATUS_CLASS_ABORTED = 'aborted';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;

type Labels = 'route' | 'method' | 'status_class';

// Registered on the shared registry: the hook is installed from instrumentation.node.ts (the
// instrumentation graph), and `/api/metrics` (the request graph) merges this registry into its scrape.
function apiRouteHistogram(): Histogram<Labels> {
  return registerInstrumentationMetric(
    API_ROUTE_DURATION_METRIC,
    () =>
      new client.Histogram({
        name: API_ROUTE_DURATION_METRIC,
        help:
          'Wall-clock seconds from request receipt to response close for pages-API routes, by route ' +
          'pattern (the pages-manifest key, e.g. /api/v1/models/[id]; anything else is other), ' +
          'method and status class (aborted when the response closed without finishing). Counts ' +
          'every request once, so _count is the per-route request rate; tRPC requests land under ' +
          '/api/trpc/[trpc] as HTTP requests (one per batch). Opt-in via API_ROUTE_METRICS=true',
        labelNames: ['route', 'method', 'status_class'] as const,
        buckets: [...TRPC_PROCEDURE_DURATION_BUCKETS],
        registers: [instrumentationRegistry],
      })
  );
}

type RouteCarrier = {
  [NEXT_REQUEST_META]?: RequestMeta;
  [STANDALONE_API_ROUTE_PAGE]?: unknown;
};

/** The route pattern the server resolved for `req`, or undefined when it resolved none. */
export function apiRoutePattern(req: object): string | undefined {
  const carrier = req as RouteCarrier;
  const standalone = carrier[STANDALONE_API_ROUTE_PAGE];
  if (typeof standalone === 'string') return standalone;
  const page = carrier[NEXT_REQUEST_META]?.match?.definition?.page;
  return typeof page === 'string' ? page : undefined;
}

export function methodLabel(method: string | undefined): string {
  return method && METHODS.has(method) ? method : API_ROUTE_OTHER;
}

export function statusClassLabel(statusCode: number, finished: boolean): string {
  if (!finished) return STATUS_CLASS_ABORTED;
  const cls = Math.floor(statusCode / 100);
  return cls >= 1 && cls <= 5 ? STATUS_CLASSES[cls - 1] : API_ROUTE_OTHER;
}

const defaultNow = () => performance.now();

/**
 * Times `req` from now until `res` closes and records it once. No-op for a non-API URL. Never
 * throws, and never touches the response beyond adding one listener.
 */
export function observeApiRequest(
  req: IncomingMessage | undefined,
  res: ServerResponse | undefined,
  now: () => number = defaultNow
): void {
  const url = req?.url;
  if (typeof url !== 'string' || !url.startsWith('/api/')) return;
  if (!res || typeof res.once !== 'function') return;
  const startedAt = now();
  res.once('close', () => {
    try {
      apiRouteHistogram().observe(
        {
          route: apiRouteLabel(apiRoutePattern(req as IncomingMessage)),
          method: methodLabel(req?.method),
          status_class: statusClassLabel(res.statusCode, res.writableFinished),
        },
        (now() - startedAt) / 1000
      );
    } catch {
      // Losing one observation is fine; failing the response is not.
    }
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __civitaiApiRouteHookedProtos: WeakSet<object> | undefined;
}

// Method syntax (bivariant parameters) so http.Server's overloaded `emit` is assignable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmitTarget = { emit(event: string | symbol, ...args: any[]): boolean };

/**
 * Wraps `proto.emit` so every `request` event is observed before the server's own listeners run.
 * Idempotent per prototype, across webpack graphs (the set lives on globalThis). Returns whether
 * this call installed it.
 */
export function installApiRouteServerHook(proto: EmitTarget = http.Server.prototype): boolean {
  const hooked = (globalThis.__civitaiApiRouteHookedProtos ??= new WeakSet());
  if (hooked.has(proto)) return false;
  hooked.add(proto);
  const original = proto.emit;
  proto.emit = function emitWithApiRouteMetrics(this: unknown, event: string | symbol) {
    if (event === 'request') {
      try {
        // eslint-disable-next-line prefer-rest-params
        observeApiRequest(arguments[1], arguments[2]);
      } catch {
        // Never let telemetry stop a request from being handled.
      }
    }
    // eslint-disable-next-line prefer-rest-params
    return original.apply(this, arguments as unknown as Parameters<EmitTarget['emit']>);
  };
  return true;
}

/** Installs the hook when API_ROUTE_METRICS=true; otherwise does nothing. Returns whether it is on. */
export function registerApiRouteMetrics(
  env: Record<string, string | undefined> = process.env,
  proto: EmitTarget = http.Server.prototype
): boolean {
  if (env.API_ROUTE_METRICS !== 'true') return false;
  installApiRouteServerHook(proto);
  return true;
}
