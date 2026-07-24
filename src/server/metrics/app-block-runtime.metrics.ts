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
  | 'images'
  | 'models'
  | 'model_detail'
  | 'me'
  | 'collections'
  | 'collection'
  | 'collection_follow'
  | 'shared_storage_top'
  | 'shared_storage_increment'
  | 'generation_resources';
// NOTE: buzz self-reads (balance/transactions/accounts/daily-compensation) are
// NOT here — they are host-mediated tRPC MUTATIONS (blocks.getMyBuzz*), not
// withBlockScope REST routes, so they are not metered via this per-endpoint
// label (mutations carry their own tRPC metrics). The former 'buzz' /
// 'buzz_transactions' / 'buzz_daily_compensation' / 'buzz_accounts' REST
// entries were retired with those endpoints (superseded by the bridges).

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
  customComfyActualBuzz: Histogram<string>;
  customComfyWallclockSeconds: Histogram<string>;
};

// ── customComfy per-engine runtime/cost buckets ──────────────────────────────
// Sized for the 0–200 range that straddles the per-engine Buzz ceilings
// (zimage 90 / flux2 150 / qwen 180) so the ceiling boundaries fall ON bucket
// edges — a pre-GA `histogram_quantile` p95/p99 then reads directly against the
// ceiling a gen is fighting.
const CUSTOMCOMFY_BUZZ_BUCKETS = [10, 20, 30, 45, 60, 90, 120, 150, 180, 200];
// Wall-clock (submit→terminal-observation) seconds — same ceiling landmarks plus
// a couple of longer tails to catch a gen that queue-waits toward / past its
// timeout (the clip-risk the metric exists to surface).
const CUSTOMCOMFY_WALLCLOCK_BUCKETS = [5, 10, 20, 30, 45, 60, 90, 120, 150, 180, 200, 240];

// Upper sanity bound on an observed wall-clock sample. The submit→terminal
// wall-clock is `Date.now() - record.submittedAt`, a derived delta that a
// clock skew, a stale/corrupt `submittedAt`, or a pathologically long
// terminal-observation gap could inflate into a junk value far past any real
// gen. The physical cap is the per-engine step timeout (≤180s today); 600s
// (~10min) sits comfortably above any real queue-wait + exec for a 180s-max
// step yet well past the 240s top bucket, so a legitimate slow gen is still
// observed while a nonsense value is DROPPED (not clamped — a clamp would fold
// junk onto the +Inf edge and pollute `_sum`/quantiles).
export const MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS = 600;

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

  // Cardinality: renders_total ≈ (A+1) × 5 slot_id × 7 error_class ≈ 1785 at
  // A=50, where A = approved apps (+1 for the 'other' bucket), slot_id = 4 known
  // + 'other', and error_class = 'none' + 5 known + 'other' (7). `result` is NOT
  // an independent multiplier — it's coupled to error_class ('none' pairs only
  // with result=ok; the 5-known+'other' pair only with result=error), so the 7
  // error_class values already encode the result split. Every factor is strictly
  // bounded, so the series count stays small.
  const rendersTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_renders_total',
    'App Block host render/impression outcomes by app, slot, result (ok|error), and error_class (none when ok; timeout|fatal|no_token|error|error_boundary|other on error)',
    ['app_block_id', 'slot_id', 'result', 'error_class']
  );

  // ── customComfy per-engine runtime/cost (App Blocks `customComfy` bridge) ────
  // Instrument-ahead-of-demand for the pre-GA question "is flux2-klein's real p99
  // approaching its 150-Buzz / 150s ceiling?". EMPTY until real customComfy volume
  // accrues (DARK app code, mod-gated), by design.
  //
  // Cardinality: one `engine` label per recipe's engine(s) + one `recipe` label per
  // registered recipe — both small server-side enums drawn from the code-owned recipe
  // registry (never client input). Today that spans e.g. seamless-pano-360's engines
  // {zimage-turbo, flux2-klein, qwen-image} plus starter-comfy-txt2img's {default}, so
  // the series count grows by a handful with each new recipe/engine — always trivially
  // bounded regardless of the wire (labels are free-form + fail-soft, but the values
  // are enum-resolved from the registry, so they can't blow up).
  const customComfyActualBuzz = getOrCreateHistogram(
    reg,
    'civitai_app_block_customcomfy_actual_buzz',
    // GPU-RUNTIME / billed Buzz (≈1 Buzz/GPU-second) — the settled `actual` cost, NOT
    // wall-clock. Answers "how close to the per-engine ceiling is real spend".
    'App Block customComfy settled GPU-runtime cost in billed Buzz (≈1 Buzz/GPU-second — NOT wall-clock) by engine and recipe',
    ['engine', 'recipe'],
    CUSTOMCOMFY_BUZZ_BUCKETS
  );

  const customComfyWallclockSeconds = getOrCreateHistogram(
    reg,
    'civitai_app_block_customcomfy_wallclock_seconds',
    // WALL-CLOCK incl. GPU queue-wait: submit→terminal-observation seconds. The truer
    // signal for the step-timeout clip risk (a fast gen hard-killed at the 150s
    // wall-clock ceiling while its GPU runtime is well under). Bounded by the ~2s
    // terminal-poll cadence + excludes the submit round-trip (see settle service).
    'App Block customComfy wall-clock seconds from submit to terminal observation (incl. GPU queue-wait) by engine and recipe',
    ['engine', 'recipe'],
    CUSTOMCOMFY_WALLCLOCK_BUCKETS
  );

  return {
    requestsTotal,
    requestDurationSeconds,
    rendersTotal,
    customComfyActualBuzz,
    customComfyWallclockSeconds,
  };
}

/**
 * Fail-soft emit of the settled GPU-runtime cost (billed `actual` Buzz) for one
 * customComfy gen. Called from the settle service at terminal. A metrics error
 * (registry/label) must NEVER perturb settle/refund correctness, so the whole
 * emit is swallowed. Skips a non-positive/`NaN` actual (failed/no-op/0 gen).
 */
export function observeCustomComfyActualBuzz(
  engine: string,
  recipe: string,
  actualBuzz: number
): void {
  try {
    if (!Number.isFinite(actualBuzz) || actualBuzz <= 0) return;
    const { customComfyActualBuzz } = ensureRegisterAppBlockRuntimeMetrics();
    customComfyActualBuzz.observe({ engine, recipe }, actualBuzz);
  } catch {
    /* instrument-only — never let a metrics error touch the settle path */
  }
}

/**
 * Fail-soft emit of the submit→terminal-observation wall-clock (seconds, incl.
 * GPU queue-wait) for one customComfy gen. Same never-throw contract as above.
 * DROPS (does not observe) a value that is non-positive/`NaN` OR above
 * `MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS` — a junk delta from clock skew / a stale
 * `submittedAt` would otherwise pollute `_sum` and the tail quantiles. Dropping
 * (not clamping) keeps the histogram honest.
 */
export function observeCustomComfyWallclockSeconds(
  engine: string,
  recipe: string,
  seconds: number
): void {
  try {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    if (seconds > MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS) return;
    const { customComfyWallclockSeconds } = ensureRegisterAppBlockRuntimeMetrics();
    customComfyWallclockSeconds.observe({ engine, recipe }, seconds);
  } catch {
    /* instrument-only — never let a metrics error touch the settle path */
  }
}
