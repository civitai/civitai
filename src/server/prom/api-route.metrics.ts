import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import client from 'prom-client';
import type { Counter } from 'prom-client';
import type { RequestMeta } from 'next/dist/server/request-meta';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { apiRouteLabel } from '~/server/utils/page-routes';

// Hooked on `http.Server`'s `emit('request')`, not an endpoint wrapper: the pages-API routes use
// many different wrappers, bare handlers included, so a wrapper hook misses some. That covers both
// `next start` and the standalone server (scripts/trpc-server/server.cjs).
//
// Counted on the response's `close`, which fires exactly once per response, finished or not. The
// route is read then because it is resolved after the request arrives: Next's route match, or the
// page the standalone server matched (`STANDALONE_API_ROUTE_PAGE_KEY`). The label is checked
// against the build's pages manifest (`apiRouteLabel`), so a URL never becomes a label.
//
// Dark unless API_ROUTE_METRICS=true.

export const API_ROUTE_REQUESTS_METRIC = PROM_PREFIX + 'api_route_requests_total';

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
function apiRouteCounter(): Counter<Labels> {
  return registerInstrumentationMetric(
    API_ROUTE_REQUESTS_METRIC,
    () =>
      new client.Counter({
        name: API_ROUTE_REQUESTS_METRIC,
        help:
          'Requests to pages-API routes, counted once when the response closes, by route pattern ' +
          '(the pages-manifest key, e.g. /api/v1/models/[id]; anything else is other), method and ' +
          'status class (aborted when the response closed without finishing). tRPC requests land ' +
          'under /api/trpc/[trpc] as HTTP requests (one per batch). Opt-in via API_ROUTE_METRICS=true',
        labelNames: ['route', 'method', 'status_class'] as const,
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

/**
 * Counts `req` once, when `res` closes. No-op for a non-API URL. Never throws, and never touches the
 * response beyond adding one listener.
 */
export function observeApiRequest(
  req: IncomingMessage | undefined,
  res: ServerResponse | undefined
): void {
  const url = req?.url;
  if (typeof url !== 'string' || !url.startsWith('/api/')) return;
  if (!res || typeof res.once !== 'function') return;
  res.once('close', () => {
    try {
      apiRouteCounter().inc({
        route: apiRouteLabel(apiRoutePattern(req as IncomingMessage)),
        method: methodLabel(req?.method),
        status_class: statusClassLabel(res.statusCode, res.writableFinished),
      });
    } catch {
      // Losing one increment is fine; failing the response is not.
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
 *
 * The wrapped emit is looked up on EVERY call, not captured here: an `emit` that `proto` itself
 * owned at install time is kept, and otherwise the parent prototype's current `emit` is called, so
 * a parent patched later (another instrumentation wrapping `http.Server.prototype.emit` after this
 * ran on a subclass) is still reached. `this`, the arguments and the return value pass through.
 */
export function installApiRouteServerHook(proto: EmitTarget = http.Server.prototype): boolean {
  const hooked = (globalThis.__civitaiApiRouteHookedProtos ??= new WeakSet());
  if (hooked.has(proto)) return false;
  hooked.add(proto);
  const ownEmit = Object.prototype.hasOwnProperty.call(proto, 'emit') ? proto.emit : undefined;
  const parent = Object.getPrototypeOf(proto) as EmitTarget;
  proto.emit = function emitWithApiRouteMetrics(this: unknown, event: string | symbol) {
    if (event === 'request') {
      try {
        // eslint-disable-next-line prefer-rest-params
        observeApiRequest(arguments[1], arguments[2]);
      } catch {
        // Never let telemetry stop a request from being handled.
      }
    }
    const next = ownEmit ?? parent.emit;
    // eslint-disable-next-line prefer-rest-params
    return next.apply(this, arguments as unknown as Parameters<EmitTarget['emit']>);
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
