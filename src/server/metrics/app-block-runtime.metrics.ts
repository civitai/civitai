// App Blocks — per-app runtime observability (prom-client).
//
// Closes the runtime-health gap for the App Blocks platform: third-party
// mini-apps rendered as iframes on model pages + /apps/run pages previously
// had NO per-app telemetry, so render failures and per-app API errors were
// invisible until a human reported them. These metrics are pure prom-client
// (no new infra, no ClickHouse migration) and are scraped by the same
// /api/metrics endpoint that exposes every other app metric.
//
// Three signals:
//   1. Per-app REST RED — emitted from block-scope.middleware for every
//      block-JWT-authed /api/v1/blocks/* call.
//   2. Render-failure signal — emitted from the /api/track/block-render beacon
//      route (ok at BLOCK_READY, error on a host render failure).
//   3. Cap-limit DEGRADE signal — emitted from app-cap-limits.service when the
//      per-app spend/velocity resolver falls back to the strictest tier.
//   4. Spend-cap REJECTION signal — emitted from app-spend-cap.service for every
//      generation submit the per-app aggregate cap actually DENIES. (3) counts
//      how often the LIMITS could not be resolved; (4) counts how many real
//      generations were turned away. They are not substitutes: (3) is
//      rate-capped by a 5s fallback cache, so a 10-submit degrade and a
//      10,000-submit degrade produce the same counter value.
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
  | 'tip_allowance'
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

/**
 * LAUNCH-LATENCY phase enum. A mirror of the client-side union in
 * `~/components/AppBlocks/launchTimings`, declared again here rather than
 * imported so this module never pulls a client module into the server graph.
 *
 * 🔴 It is also the cardinality bound, and it is CODE-OWNED: the `phase` label
 * is never taken from the beacon body. The client sends three named numeric
 * fields; this module maps them onto these three literals. A client cannot
 * invent a fourth.
 */
export const APP_BLOCK_LAUNCH_PHASES = ['token_mint', 'frame_fetch', 'init_wait'] as const;
export type AppBlockLaunchPhase = (typeof APP_BLOCK_LAUNCH_PHASES)[number];

/**
 * Why `resolveAppCapLimits` fell back to `STRICTEST_APP_CAP_LIMITS` instead of
 * resolving the app's real ceilings. The two mean DIFFERENT things and an
 * operator responds to them differently, which is the whole reason this is a
 * label and not one undifferentiated counter:
 *
 *   - `db_error`    — the `app_blocks` read THREW (DB unreachable, pool
 *                     exhausted, the override columns not yet applied in this
 *                     environment). INFRA trouble; usually fleet-wide and
 *                     correlated with other DB symptoms. Every app degrades at
 *                     once. This is the page-worthy one.
 *   - `missing_row` — the read SUCCEEDED and returned nothing. There is no such
 *                     app: a newly created app racing its first submit, an app
 *                     deleted mid-session, or a synthetic dev id that slipped
 *                     the caller's `claims.dev` exclusion. Scoped to ONE app,
 *                     and a steady non-zero rate here means a real bug in an
 *                     id-minting path, not a database problem.
 *
 * 🔴 Both resolve to a REAL, enforced ceiling (today's shipped 5,000,000/120) —
 * never to "uncapped". The signal exists because the degrade is otherwise
 * INVISIBLE: an app silently pinned to the strictest tier looks exactly like an
 * app that is simply busy, right up until its users start seeing abuse
 * rejections it did not earn.
 */
export type AppCapLimitsDegradeReason = 'db_error' | 'missing_row';

/**
 * Why `reserveAppSpend` REJECTED one block-initiated generation submit. This is
 * the SINGLE SOURCE for the union — `ReserveAppSpendResult['reason']` in
 * `app-spend-cap.service.ts` is this same type (imported type-only, so nothing
 * pulls prom-client into that module's static graph). Keeping one declaration is
 * what stops the label set and the service's own contract from drifting apart:
 * a new rejection cause cannot be returned without appearing here, and adding
 * one here is a deliberate, reviewable widening of the metric's cardinality.
 *
 *   - `daily`       — the per-app daily Buzz ceiling would be exceeded. The
 *                     MONEY bound: this app's viewers have collectively spent
 *                     its budget for the UTC day. Expected to be sticky (it
 *                     stays denied until the day rolls over).
 *   - `velocity`    — the per-app short-window generation ceiling was exceeded.
 *                     The RATE bound: bursty and self-clearing within one
 *                     window, and the one a legitimately busy app trips first.
 *   - `unavailable` — a Redis error, or a limit-resolution throw, on the reserve
 *                     path → fail closed (deny, no spend). NOT an abuse signal
 *                     at all: it is infra, and every app is denied at once.
 *
 * 🔴 EXACTLY THESE THREE, and `reason` is the ONLY label. See the counter below
 * for why no app/user/block id may join them.
 */
export const APP_SPEND_CAP_REJECTION_REASONS = ['daily', 'velocity', 'unavailable'] as const;

export type AppSpendCapRejectionReason = (typeof APP_SPEND_CAP_REJECTION_REASONS)[number];

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
 *   - token_lost_midsession — the host had ALREADY reached `ready` and then lost its
 *                      credential terminally (delist/suspend/revoke → the mint
 *                      settled on a terminal 4xx with nothing usable left). This is
 *                      the ONLY class that describes a teardown of a page load that
 *                      had already SUCCEEDED, which is exactly why it must be
 *                      distinguishable from the launch-failure classes above: on the
 *                      wire it arrives as a SECOND beacon for a mount whose first
 *                      beacon said `ok`. See the mid-session effect in PageBlockHost.
 * Anything else is bucketed to 'other'. A successful render uses 'none'.
 *
 * 🔴 THE ALLOWLIST IS THE CARDINALITY BOUND. `errorClass` arrives in a public,
 * client-supplied beacon body (schema-capped at 64 chars but otherwise free-form).
 * Adding a member here is the ONLY way a new value can become a prom label — every
 * other string collapses to the single 'other' bucket in `normalizeErrorClass`
 * below. Keep this set small and code-owned; never derive it from input.
 */
const KNOWN_ERROR_CLASSES = new Set([
  'timeout',
  'fatal',
  'no_token',
  'error',
  'error_boundary',
  'token_lost_midsession',
]);

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
/**
 * Map one client-reported millisecond leg to a histogram sample in SECONDS, or
 * `null` if it must not be observed.
 *
 * 🔴 THE TWO RULES THIS ENCODES, both of which produce a *plausible wrong
 * number* rather than an error when violated:
 *
 *   1. NEVER OBSERVE A ZERO. A leg that was not measured (no
 *      `Timing-Allow-Origin`, no resource entry, a mark never taken) arrives as
 *      0 or absent. A 0 in a latency histogram is indistinguishable from an
 *      instant leg and drags every percentile toward the bottom bucket — in the
 *      reassuring direction, which is why nobody notices.
 *   2. DROP, NEVER CLAMP, AN OUT-OF-RANGE SAMPLE. Mirrors
 *      `observeCustomComfyWallclockSeconds`: a clamp folds junk onto the `+Inf`
 *      edge and pollutes `_sum` and the tail with a value that never happened.
 *
 * The client applies the same two gates (`boundedDeltaMs`), deliberately — the
 * guarantee must not rest on either side alone, and this side is the one facing
 * a public, client-controlled beacon body.
 */
export function launchSampleSeconds(ms: unknown): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (!(ms > 0)) return null;
  const seconds = ms / 1000;
  if (seconds > MAX_APP_BLOCK_LAUNCH_SECONDS) return null;
  return seconds;
}

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
  capLimitsDegradedTotal: Counter<string>;
  spendCapRejectionsTotal: Counter<string>;
  stepPriceCheckTotal: Counter<string>;
  launchTotalSeconds: Histogram<string>;
  launchPhaseSeconds: Histogram<string>;
};

// ── App Block LAUNCH latency ────────────────────────────────────────────────
// Bucket edges chosen against the REAL constants of the launch path, not from a
// generic ladder. prom-client's defaults are structurally unable to answer the
// two questions this metric exists for: their top is 10s with nothing between 5
// and 10, and they have no edge at 0.4.
//
//   0.25 — LAUNCH_REVEAL_MS (260ms, PageBlockHost). Below this edge the launch
//          is already hidden behind the cross-fade: an "already optimal" bucket.
//   0.4 / 0.8
//        — exactly one and two INIT_RETRY_INTERVAL_MS ticks
//          (iframeInitController). The first BLOCK_INIT is posted synchronously
//          on start(); if the block's listener has not attached yet that post is
//          dropped and the next is a FULL 400ms later. If that quantization is
//          real it shows up as mass piling immediately above 0.4 — and a generic
//          0.25→0.5→1 ladder would hide it completely.
//   10   — BLOCK_READY_TIMEOUT_MS. 🔴 A `launch_total` sample above 10s is
//          STRUCTURALLY IMPOSSIBLE on the success path: at 10s the controller
//          fires onReadyTimeout, the status goes 'timeout', and no `ok` beacon
//          is ever sent. So a non-zero `+Inf − le=10` on launch_total is a BUG
//          SIGNAL, not a slow launch.
//   15   — TOKEN_WAIT_TIMEOUT_MS. Only the `token_mint` phase can legitimately
//          reach here (the ready timeout is armed by start(), gated on hasToken).
const APP_BLOCK_LAUNCH_BUCKETS = [0.1, 0.25, 0.4, 0.6, 0.8, 1.2, 1.8, 2.5, 4, 6, 8, 10, 15];

/**
 * Upper sanity bound on a single launch sample, in seconds. 30s sits well above
 * TOKEN_WAIT_TIMEOUT_MS (15s), the longest leg that can legitimately complete.
 * Past that it is a suspended tab, a clock anomaly, or a bug — DROPPED, not
 * clamped (see `launchSampleSeconds`).
 */
export const MAX_APP_BLOCK_LAUNCH_SECONDS = 30;

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

  // Cardinality: renders_total ≈ (A+1) × 5 slot_id × 8 error_class ≈ 2040 at
  // A=50, where A = approved apps (+1 for the 'other' bucket), slot_id = 4 known
  // + 'other', and error_class = 'none' + 6 known + 'other' (8). `result` is NOT
  // an independent multiplier — it's coupled to error_class ('none' pairs only
  // with result=ok; the 6-known+'other' pair only with result=error), so the 8
  // error_class values already encode the result split. Every factor is strictly
  // bounded (see the KNOWN_* sets + boundAppBlockIdLabel), so the series count
  // stays small and CANNOT be grown by client input — only by a code change here.
  const rendersTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_renders_total',
    'App Block host render/impression outcomes by app, slot, result (ok|error), and error_class (none when ok; timeout|fatal|no_token|error|error_boundary|token_lost_midsession|other on error)',
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

  // ── per-app cap-limit DEGRADE ────────────────────────────────────────────────
  // 🔴 NO `app_block_id` LABEL, deliberately. `missing_row` fires precisely for
  // ids that are NOT in the app catalog, so the label set would be seeded from
  // exactly the unbounded population `known-app-blocks.service.ts` exists to
  // clamp — and prom-client retains every distinct label set in the Node heap
  // forever (the --max-old-space-size exit-139 OOM class). The usual clamp
  // (`boundAppBlockIdLabel`) is unusable here twice over: it needs a DB read,
  // which is the very thing that is broken on the `db_error` path, and a
  // `missing_row` id can never be in the approved set, so it would collapse to
  // 'other' in the one case an operator most wants attributed.
  //
  // So the split is: this counter is the ALERTABLE aggregate (2 series total),
  // and the paired `console.warn` in app-cap-limits.service carries the specific
  // `appBlockId` for the operator who is already looking. Alert on the metric,
  // attribute from the log.
  const capLimitsDegradedTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_cap_limits_degraded_total',
    'App Block per-app spend/velocity cap-limit resolutions that DEGRADED to the strictest tier, by reason (db_error = the app_blocks read threw, i.e. infra; missing_row = the read succeeded but there is no such app)',
    ['reason']
  );

  // ── per-app spend-cap REJECTIONS ─────────────────────────────────────────────
  // The signal that can size USER IMPACT. `capLimitsDegradedTotal` above counts
  // cap-limit RESOLUTIONS that fell back — and it is rate-capped by the 5s
  // fallback cache + single-flight, so a degrade affecting 10 submits and one
  // affecting 10,000 produce the SAME counter value. It structurally cannot
  // answer "how many generations were turned away", which is the question the
  // whole cap-observability arc exists for ("users hitting abuse rejections they
  // did not earn"). This counter answers it: one increment per DENIED submit, no
  // cache in front of it.
  //
  // 🔴 EXACTLY ONE LABEL, `reason`, over a 3-value code-owned union → 3 series,
  // TOTAL, forever. Deliberately NO `app_block_id` / `user_id` / block id: this
  // fires once per denied submit (unlike the degrade counter, nothing caches or
  // rate-limits it), so a per-app label would multiply an unbounded-ish
  // population by a per-request emit rate, and prom-client retains every distinct
  // label set in the Node heap forever (the --max-old-space-size exit-139 OOM
  // class) across ~130 scraped pods. Attribution belongs in the caller's log line
  // / trace, which already carries appBlockId, userId, and the resolved ceilings
  // (`ReserveAppSpendResult.limits`). Alert on the metric, attribute from the log
  // — the same split as the degrade counter above.
  const spendCapRejectionsTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_spend_cap_rejections_total',
    'App Block generation submits DENIED by the per-app aggregate spend/velocity cap, by reason (daily = the per-app daily Buzz ceiling would be exceeded; velocity = the per-app short-window gen ceiling was exceeded; unavailable = a Redis/limit-resolution error, fail-closed deny)',
    ['reason']
  );

  // ── `kind: 'step'` prepaidFixed PRICE CHECK ──────────────────────────────────
  // 🔴 Instruments whether the registry's DECLARED price still matches what the
  // orchestrator actually bills for a `prepaidFixed` step type. A declared price
  // that drifts below the real one leaves every cap counter short.
  //
  // 🔴 WHY THIS FIRES ON EVERY SUBMIT, NOT ONLY ON A DIVERGENCE. A
  // divergence-only counter cannot distinguish "the price is right" from "the
  // detector never ran" — both read as a flat zero forever, and the second is
  // the state where the mitigation is inert. That is not a hypothetical: the
  // detector reads `snapshot.cost?.total`, which `snapshotFromWorkflow` OMITS
  // when the orchestrator returns no numeric cost, and the step submit passes no
  // `wait`, so the response returns as soon as the job queues. (Measured
  // 2026-08-02 against the live orchestrator: a queued `convertImage` submit —
  // HTTP 202, status `processing` — DOES carry `cost.total`, so the precondition
  // holds today. It was unverified before, and it is not guaranteed for a future
  // step type.)
  //
  // So the `outcome` label carries the non-divergent case too:
  //   exact  — realized cost ≤ the reservation. The healthy state, and PROOF the
  //            detector is live.
  //   over   — realized cost EXCEEDED the reservation. A registry bug: the entry
  //            needs a higher price, or a different billing mode, because
  //            "deterministic cost knowable before execution" was false for it.
  //   absent — no numeric cost on the snapshot, so nothing could be compared.
  //            The state that used to be indistinguishable from `exact`.
  //
  // Alert on `outcome="over"`; read `outcome="exact"` to confirm the check runs
  // at all; investigate a rising `outcome="absent"`.
  //
  // Cardinality: `step` is drawn from the code-owned registry keys (never client
  // input — the wire enum derives from those same keys, so an unregistered id
  // cannot reach here); `outcome` is a closed 3-value set. Bounded and small.
  const stepPriceCheckTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_step_price_check_total',
    "App Block `kind:'step'` prepaidFixed price checks at submit, by step id and outcome (exact = realized cost within the reservation; over = the orchestrator billed MORE than reserved, i.e. the declared price is wrong; absent = the snapshot carried no numeric cost, so no comparison was possible)",
    ['step', 'outcome']
  );

  // ── LAUNCH LATENCY — TWO histograms, deliberately, not one ──────────────────
  //
  // 🔴 THE SPLIT IS THE CARDINALITY DESIGN, not a stylistic choice. A single
  // combined {app_block_id, phase} histogram would be ~51 apps × 3 phases × 15
  // bucket series ≈ 2,295 series PER POD, across ~130 scraped dp-prod pods — and
  // prom-client retains every distinct label set in the Node heap forever (the
  // --max-old-space-size exit-139 OOM class). Split as below it is ~765 + 45
  // ≈ 810/pod at full app saturation, in line with the existing
  // `civitai_app_block_request_duration_seconds{app_block_id, endpoint}`
  // precedent rather than an order of magnitude past it.
  //
  // Per-app PHASE attribution is therefore NOT available from prom. That is the
  // same alert-on-the-metric / attribute-from-the-log split the degrade and
  // spend-cap counters above already make.
  const launchTotalSeconds = getOrCreateHistogram(
    reg,
    'civitai_app_block_launch_total_seconds',
    'App Block end-to-end launch seconds (host mount -> BLOCK_READY) by app. Successful launches only: a failure beacon has no BLOCK_READY, and a mid-session teardown (`secondary`) is not a launch. Answers "which app is slow".',
    ['app_block_id'],
    APP_BLOCK_LAUNCH_BUCKETS
  );

  // 🔴 NO app_block_id LABEL, deliberately (see the cardinality note above).
  //
  // 🔴 AND THE PHASES DO NOT SUM TO `launch_total`. The token mint and the
  // cross-origin frame load run in PARALLEL — the iframe mounts on the first
  // client render, before any token exists — so the launch waits on
  // max(token, block-listener), not on a sum. Reading these as a serial
  // breakdown is the single most likely misuse of this metric.
  //
  // All three phases are available at 100% coverage, on every app, today: the
  // 2026-08-03 Chromium measurement showed the cross-origin iframe entry carries
  // a real `duration` without `Timing-Allow-Origin` (only the DNS/connect/TTFB
  // decomposition is TAO-gated, and that breakdown is deferred — see
  // launchTimings.ts). So there is no coverage caveat and no biased subset.
  const launchPhaseSeconds = getOrCreateHistogram(
    reg,
    'civitai_app_block_launch_phase_seconds',
    'App Block launch PHASE seconds by phase (token_mint = host mount -> first token; frame_fetch = the cross-origin iframe document fetch, from the parent resource-timing entry; init_wait = first BLOCK_INIT -> BLOCK_READY). 🔴 The phases are PARALLEL legs of one race (the iframe mounts before any token exists) and do NOT sum to launch_total.',
    ['phase'],
    APP_BLOCK_LAUNCH_BUCKETS
  );

  return {
    requestsTotal,
    requestDurationSeconds,
    rendersTotal,
    customComfyActualBuzz,
    customComfyWallclockSeconds,
    capLimitsDegradedTotal,
    spendCapRejectionsTotal,
    stepPriceCheckTotal,
    launchTotalSeconds,
    launchPhaseSeconds,
  };
}

/**
 * The client-reported launch timings, as they arrive on the block-render beacon
 * (milliseconds; every field optional/unvalidated from this function's point of
 * view — the zod schema bounds them, this clamps them again).
 */
export type AppBlockLaunchTimings = {
  totalMs?: unknown;
  tokenMintMs?: unknown;
  frameFetchMs?: unknown;
  initWaitMs?: unknown;
};

/**
 * Fail-soft emit of ONE App Block launch observation.
 *
 * 🔴 CALL ONLY FOR A SUCCESSFUL, NON-SECONDARY RENDER BEACON. A launch-FAILURE
 * beacon never saw BLOCK_READY, so its `total` is meaningless and observing it
 * would record the failure as a *fast* launch; a `secondary` beacon describes a
 * teardown minutes after a launch that already succeeded. Either one poisons the
 * distribution in the direction that looks healthy.
 *
 * 🔴 `total` IS THE ANCHOR. If it does not survive `launchSampleSeconds`, NOTHING
 * is observed — not even a phase that would have passed on its own. Orphan phase
 * samples with no end-to-end number to interpret them against are worse than no
 * samples: they still move the phase percentiles.
 *
 * 🔴 TOTAL (never throws), like every emitter in this module: it runs on a
 * fire-and-forget public telemetry route, and a label/registry error must never
 * turn a beacon into a 500.
 */
export function observeAppBlockLaunch(
  appBlockIdLabel: string,
  timings: AppBlockLaunchTimings | undefined
): void {
  try {
    if (!timings) return;
    const total = launchSampleSeconds(timings.totalMs);
    if (total === null) return;

    const { launchTotalSeconds, launchPhaseSeconds } = ensureRegisterAppBlockRuntimeMetrics();
    launchTotalSeconds.observe({ app_block_id: appBlockIdLabel }, total);

    const phases: Array<[AppBlockLaunchPhase, unknown]> = [
      ['token_mint', timings.tokenMintMs],
      ['frame_fetch', timings.frameFetchMs],
      ['init_wait', timings.initWaitMs],
    ];
    for (const [phase, ms] of phases) {
      const seconds = launchSampleSeconds(ms);
      if (seconds === null) continue;
      launchPhaseSeconds.observe({ phase }, seconds);
    }
  } catch {
    /* instrument-only — never let a metrics error touch the beacon response */
  }
}

/**
 * The closed outcome set for `civitai_app_block_step_price_check_total`. Keeping
 * it a union (rather than a bare string) is what bounds the label cardinality at
 * the type level — a caller cannot invent a fourth value.
 */
export type StepPriceCheckOutcome = 'exact' | 'over' | 'absent';

/**
 * Fail-soft emit of ONE `prepaidFixed` step price check. Called from the step
 * submit path on EVERY submit, after the money has already moved.
 *
 * 🔴 Emitted unconditionally — including `outcome: 'exact'` — so a flat
 * divergence line can be told apart from a detector that never ran. See the
 * counter's definition above for why that distinction is load-bearing.
 *
 * 🔴 TOTAL, like every emitter in this module. It reports on an already-billed
 * submit; a metrics error must never turn a successful generation into a 500.
 */
export function recordStepPriceCheck(step: string, outcome: StepPriceCheckOutcome): void {
  try {
    const { stepPriceCheckTotal } = ensureRegisterAppBlockRuntimeMetrics();
    stepPriceCheckTotal.inc({ step, outcome });
  } catch {
    /* instrument-only — never let a metrics error touch an already-billed submit */
  }
}

/**
 * Fail-soft emit of one per-app cap-limit DEGRADE (the resolver fell back to
 * `STRICTEST_APP_CAP_LIMITS`). Called from `app-cap-limits.service`.
 *
 * 🔴 TOTAL, like the customComfy emitters above. The thing this instruments is a
 * fail-closed SAFETY path; a metrics error (registry collision, label mismatch)
 * must never propagate into it and turn "degraded but still generating" into
 * "generation down". The caller guards too — two layers, because the guarantee
 * must not depend on either one alone.
 *
 * COST: one in-heap counter increment on an already-degraded path. The hot path
 * (a warm cap-limits cache hit) never reaches here at all, and neither does a
 * cache miss that RESOLVES — only an actual degrade emits.
 */
export function recordAppCapLimitsDegrade(reason: AppCapLimitsDegradeReason): void {
  try {
    const { capLimitsDegradedTotal } = ensureRegisterAppBlockRuntimeMetrics();
    capLimitsDegradedTotal.inc({ reason });
  } catch {
    /* instrument-only — never let a metrics error touch the cap guardrail */
  }
}

/**
 * Fail-soft emit of one per-app spend-cap REJECTION (`reserveAppSpend` denied a
 * submit). Called from `app-spend-cap.service`.
 *
 * 🔴 TOTAL, like every emitter in this module. The thing it instruments is the
 * money/abuse guardrail on the generation submit path: a metrics error (registry
 * collision, label mismatch) must never propagate, or an intended 402/429
 * rejection becomes a 500 — i.e. the observability would convert a working
 * guardrail into an outage. The caller guards independently too; the duplication
 * is deliberate, because the guarantee must not rest on either layer alone.
 *
 * COST: one in-heap counter increment on an already-rejecting path. An ALLOWED
 * submit never reaches here, so the steady state on a healthy app is zero emits.
 */
export function recordAppSpendCapRejection(reason: AppSpendCapRejectionReason): void {
  try {
    const { spendCapRejectionsTotal } = ensureRegisterAppBlockRuntimeMetrics();
    spendCapRejectionsTotal.inc({ reason });
  } catch {
    /* instrument-only — never let a metrics error touch the spend guardrail */
  }
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
