// App Blocks — per-app runtime observability (prom-client).
//
// Closes the runtime-health gap for the App Blocks platform: third-party
// mini-apps rendered as iframes on model pages + /apps/run pages previously
// had NO per-app telemetry, so render failures and per-app API errors were
// invisible until a human reported them. These metrics are pure prom-client
// (no new infra, no ClickHouse migration) and are scraped by the same
// /api/metrics endpoint that exposes every other app metric.
//
// Two signals:
//   1. Per-app REST RED — emitted from block-scope.middleware for every
//      block-JWT-authed /api/v1/blocks/* call.
//   2. Render-failure signal — emitted from the /api/track/block-render beacon
//      route (ok at BLOCK_READY, error on a host render failure).
//
// prom-client GOTCHA: Next.js can import a module twice (hot reload / route
// bundling), and prom-client throws if a metric name is registered twice. Every
// getter below is a get-or-create guard against the DEFAULT global registry
// (`client.register`) — a second import reuses the existing metric instance,
// exactly like ~/server/metrics/feed-image-existence-check.metrics.ts.
//
// CARDINALITY BUDGET: `app_block_id` is bounded to APPROVED apps (dozens today;
// could reach hundreds at true-public GA). Acceptable for prom labels now. At
// GA an allowlist/cap (bucket unknown ids into 'other') may be needed — the
// render beacon in particular takes app_block_id from a same-origin client body
// (not a verified JWT like the REST-RED path), so a GA hardening pass should
// cap it there first. `endpoint`, `result`, and `slot_id` are strictly
// enumerated (see AppBlockEndpoint / normalizeSlotId / *Result below) so they
// can never blow up cardinality regardless of client input.
import client, { type Counter, type Histogram, type Registry } from 'prom-client';

/**
 * Low-cardinality LOGICAL endpoint names for the block REST surface. Passed by
 * each `withBlockScope(...)` call site (derived from the HANDLER, never from
 * `req.url`), so ids in the path can never leak into the label.
 */
export type AppBlockEndpoint =
  | 'tip'
  | 'buzz'
  | 'images'
  | 'models'
  | 'model_detail'
  | 'me'
  | 'collections'
  | 'collection'
  | 'collection_follow'
  | 'shared_storage_top'
  | 'shared_storage_increment';

export type AppBlockRequestResult = 'success' | 'client_error' | 'server_error' | 'forbidden';

export type AppBlockRenderResult = 'ok' | 'error';

/** Known render slots. Anything else is bucketed to 'other' to bound the label. */
const KNOWN_SLOT_IDS = new Set([
  'app.page',
  'model.sidebar_top',
  'model.below_images',
  'model.actions_extra',
]);

/**
 * Known render-failure discriminators the hosts emit:
 *   - timeout        — iframe never reached BLOCK_READY within the readiness window
 *   - fatal          — the block posted BLOCK_ERROR{fatal:true}
 *   - no_token       — the block token never resolved
 *   - error          — a hard token-mint failure (PageBlockHost only)
 *   - error_boundary — the host React tree threw (BlockErrorBoundary caught it)
 * Anything else is bucketed to 'other'. A successful render uses 'none'.
 */
const KNOWN_ERROR_CLASSES = new Set(['timeout', 'fatal', 'no_token', 'error', 'error_boundary']);

/**
 * Clamp a client-supplied slotId to the enumerated slot set (unknown → 'other')
 * so the `slot_id` prom label can never explode even though the beacon body is
 * client-controlled.
 */
export function normalizeSlotId(slotId: string): string {
  return KNOWN_SLOT_IDS.has(slotId) ? slotId : 'other';
}

/**
 * Resolve the strictly-bounded `error_class` render label. A successful render
 * (`result==='ok'`) is always 'none'; on error the client-sent errorClass is
 * kept only if it's in the known set, else 'other'. A raw/unbounded errorClass
 * can never become the label (the beacon body is client-controlled).
 */
export function normalizeErrorClass(
  result: AppBlockRenderResult,
  errorClass: string | undefined
): string {
  if (result === 'ok') return 'none';
  return errorClass && KNOWN_ERROR_CLASSES.has(errorClass) ? errorClass : 'other';
}

/**
 * Map an HTTP status code to the enumerated REST `result` label. 401/403 fold
 * into `forbidden` (auth/scope rejections — the middleware's own 403s land here
 * too); other 4xx → `client_error`; 5xx → `server_error`; else `success`.
 */
export function statusToRequestResult(status: number): AppBlockRequestResult {
  if (status >= 500) return 'server_error';
  if (status === 401 || status === 403) return 'forbidden';
  if (status >= 400) return 'client_error';
  return 'success';
}

function getOrCreateCounter(
  reg: Registry,
  name: string,
  help: string,
  labelNames: string[]
): Counter<string> {
  const existing = reg.getSingleMetric(name) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({ name, help, labelNames, registers: [reg] });
}

function getOrCreateHistogram(
  reg: Registry,
  name: string,
  help: string,
  labelNames: string[],
  buckets?: number[]
): Histogram<string> {
  const existing = reg.getSingleMetric(name) as Histogram<string> | undefined;
  if (existing) return existing;
  // prom-client v14 throws if `buckets` is present-but-undefined (it calls
  // `.reduce` on it) — only pass the key when we actually have custom buckets,
  // otherwise let prom-client apply its DEFAULT buckets.
  return new client.Histogram({
    name,
    help,
    labelNames,
    ...(buckets ? { buckets } : {}),
    registers: [reg],
  });
}

type Bundle = {
  requestsTotal: Counter<string>;
  requestDurationSeconds: Histogram<string>;
  rendersTotal: Counter<string>;
};

/**
 * Idempotent: safe to call on every request. Returns the metric instances
 * (existing or newly created) from the default registry that /api/metrics
 * scrapes.
 */
export function ensureRegisterAppBlockRuntimeMetrics(reg: Registry = client.register): Bundle {
  const requestsTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_requests_total',
    'App Block REST requests by app, logical endpoint, and outcome (success|client_error|server_error|forbidden)',
    ['app_block_id', 'endpoint', 'result']
  );

  const requestDurationSeconds = getOrCreateHistogram(
    reg,
    'civitai_app_block_request_duration_seconds',
    'App Block REST request duration in seconds by app and logical endpoint',
    ['app_block_id', 'endpoint']
    // default buckets are fine for this REST surface
  );

  // Cardinality: renders_total ≈ (approvedApps+1 for 'dev'/'other') × 5 slot_id
  // (4 known + 'other') × 6 error_class ('none' + 5 known + 'other', but 'none'
  // only pairs with result=ok and the 5+other only with result=error) × 2 result
  // — every factor strictly bounded, so the series count stays small.
  const rendersTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_renders_total',
    'App Block host render/impression outcomes by app, slot, result (ok|error), and error_class (none when ok; timeout|fatal|no_token|error|error_boundary|other on error)',
    ['app_block_id', 'slot_id', 'result', 'error_class']
  );

  return { requestsTotal, requestDurationSeconds, rendersTotal };
}
