import client from 'prom-client';

// ---------------------------------------------------------------------------
// Unsampled REST request counter by credential type
// ---------------------------------------------------------------------------
//
// WHY: what share of public API traffic carries an API key, a session cookie or
// nothing at all was only ever INFERRED (from spanmetrics, which are head-sampled,
// or from per-route log lines). This counts it directly, once per completed
// response, for every route on the endpoint-helper wrappers (`withApiMetrics`).
//
// LABELS, both from fixed sets so the series count is bounded by construction:
//  - `surface`    `v1` for `/api/v1/*`, `other` for every other wrapped route. No
//                 per-route label on purpose: normalizing a route costs a URL parse
//                 and a map build, and the hot-path budget here is one listener and
//                 a couple of string compares (see http-errors.ts HOT PATH).
//  - `credential` see `apiCredentialLabel` in `~/server/utils/endpoint-helpers`.
//
// SCOPE: counted on `finish`, so a response the app never completes (client abort
// before the body, an edge timeout) is not counted — the same scope as
// `civitai_app_http_errors_total`. Routes that do not use the wrappers (e.g. the
// `/api/v1/blocks/*` handlers) are not counted either.
//
// INVARIANT: import ONLY from the request webpack graph, for the reason given in
// http-errors.ts (the default registry `/api/metrics` scrapes is per graph).

export const API_REQUESTS_METRIC = 'civitai_app_api_requests_total';

export const API_SURFACES = ['v1', 'other'] as const;
export type ApiSurface = (typeof API_SURFACES)[number];

declare global {
  // eslint-disable-next-line no-var
  var __civitaiApiRequestsCounter: client.Counter<'surface' | 'credential'> | undefined;
}

// Pinned on globalThis for the same HMR / double-eval reason as httpErrorCounter.
export const apiRequestsCounter: client.Counter<'surface' | 'credential'> =
  globalThis.__civitaiApiRequestsCounter ??
  (globalThis.__civitaiApiRequestsCounter = new client.Counter({
    name: API_REQUESTS_METRIC,
    help:
      'Completed REST responses on the endpoint-helper wrappers, by surface ' +
      '(v1 = /api/v1/*, other) and credential: anonymous (none presented), ' +
      'key_header / key_param (an API key resolved from the Authorization header / ' +
      'the ?token= query parameter), cookie (a session cookie resolved), unverified ' +
      '(a credential was presented but nothing on this request resolved it: the ' +
      'route never authenticates, or the credential was invalid). UNSAMPLED. ' +
      'OPTIONS preflights excluded.',
    labelNames: ['surface', 'credential'] as const,
  }));

export function apiSurfaceLabel(url: string | undefined): ApiSurface {
  return url?.startsWith('/api/v1/') ? 'v1' : 'other';
}

/** Metrics must never fail the request they observe. */
export function recordApiRequest(surface: ApiSurface, credential: string): void {
  try {
    apiRequestsCounter.inc({ surface, credential });
  } catch {
    // Losing one increment is fine.
  }
}
