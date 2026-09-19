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
 * each `withBlockScope(...)` call site, so ids in the path can never leak into
 * the label.
 *
 * 🔴 "DERIVED FROM THE HANDLER" IS NO LONGER THE WHOLE STORY, and the
 * distinction that survives is the one that matters. A call site may pass a
 * RESOLVER instead of a literal, and `blocks/tools` does — its label depends on
 * `req.method`. So the label is not purely handler-derived any more. What is
 * still absolute: every value a resolver can return is written out at the call
 * site and typed as this union, so the label set stays enumerated and bounded,
 * and nothing is ever derived from `req.url` or any other free-form
 * client-controlled input.
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
  | 'generation_resources'
  // The read-only chat-tool surface (#398 AC5). It is a model-shaped view of
  // the SAME clamped catalog path 'models' serves, and it shares that
  // endpoint's per-token rate-limit budget deliberately — so it gets its own
  // label for attribution, not its own allowance.
  //
  // 🔴 TWO LABELS FOR ONE PATH, BECAUSE ONE PATH SERVES TWO DIFFERENT
  // WORKLOADS. `GET /api/v1/blocks/tools` returns static declarations from an
  // in-process registry; `POST` runs a Meilisearch query and a catalog read.
  // Labelling both 'tools' merged a free constant-time read with the only
  // request on this route that can be slow, rate-limited or 503 — so the RED
  // series could not answer "are tool CALLS degrading", which is the question
  // it exists for. The p95 of the merged series is dominated by whichever
  // outnumbers the other, and the declarations GET outnumbers the calls.
  | 'tools'
  | 'tools_call';
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
 * is never taken from the beacon body. The client sends named numeric fields;
 * this module maps them onto these literals. A client cannot invent a third —
 * including by sending `frameFetchMs`, which is deliberately not mapped (see the
 * DEFERRED note in launchTimings.ts) and is pinned by a test.
 */
export const APP_BLOCK_LAUNCH_PHASES = ['token_mint', 'init_wait'] as const;
export type AppBlockLaunchPhase = (typeof APP_BLOCK_LAUNCH_PHASES)[number];

/**
 * The `hello` stratifier's closed label set. CODE-OWNED, exactly like `phase`:
 * the beacon carries a BOOLEAN and this module maps it onto these two literals,
 * so no client-supplied string can ever reach a label value.
 *
 * 🔴 MEANING — one fact, named precisely, because two readings exist and they
 * disagree on real launches:
 *
 *   `yes` — the guest sent BLOCK_HELLO at some point during the launch window.
 *   `no`  — it did not.
 *
 * 🔴 IT IS **NOT** "the accelerator fired an extra BLOCK_INIT". A hello arriving
 * before the controller starts is recorded but posts nothing (`start()` posts
 * immediately anyway). Under the other reading that launch would be filed `no`
 * while its listener was demonstrably attached — pushing a fast,
 * accelerator-capable launch into the population that exists to isolate
 * cadence-bound ones, and biasing the read toward "the change did nothing".
 * The client-side argument is on `LaunchMarks.helloSeen`.
 *
 * WHY IT EXISTS: the four deployed apps shipping the accelerator are the
 * majority of launch traffic, and BLOCK_HELLO short-circuits precisely the wait
 * the re-post cadence governs. Without this label the fleet-wide `init_wait`
 * distribution is mostly composed of launches the cadence change barely touches,
 * that mass cannot be separated (the phase histogram carries no `app_block_id`
 * by design), and a diluted null is indistinguishable from no effect.
 */
export const APP_BLOCK_LAUNCH_HELLO = ['yes', 'no', 'unknown'] as const;
export type AppBlockLaunchHello = (typeof APP_BLOCK_LAUNCH_HELLO)[number];

/**
 * Map the beacon's boolean onto the label. TOTAL — every launch gets a bucket.
 *
 * 🔴 ABSENT IS NEITHER `yes` NOR `no`; IT IS ITS OWN VALUE. A client older than
 * this field omits it; a launch that saw no hello sends `false`. Collapsing the
 * two would file every stale-client launch into the `no` population this metric
 * exists to isolate — a systematic bias in the direction that flatters the
 * cadence change.
 *
 * 🔴 BUT DROPPING THE SAMPLE IS ALSO WRONG, and that was this function's first
 * design. Measured: on the previous revision a beacon with no `hello` key
 * contributed NO `launch_phase_seconds` sample at all, while the same beacon
 * against the pre-label module contributed one. That is a silent COVERAGE
 * REGRESSION on an existing metric — and it is not bounded by a deploy window,
 * because the "old client" here is a BROWSER BUNDLE, not a server pod: the
 * beacon route deliberately skips the client-version middleware, so a tab opened
 * before the deploy keeps sending the old shape for as long as it stays open.
 *
 * Worse, the loss is CORRELATED with the thing being measured. A pre-label
 * bundle is also a pre-cadence-change bundle, so the dropped launches are
 * systematically the slow-cadence ones — removing them makes the unstratified
 * phase aggregate look FASTER than reality across the deploy, in the direction
 * that flatters the change. A drop is only harmless when droppedness is
 * independent of latency, and here it is not.
 *
 * So the third bucket keeps the sample VISIBLE without contaminating either
 * analysis population: `sum without (hello)` recovers exactly the pre-label
 * series, `yes`/`no` stay clean, and the size of the stale-client tail is a
 * value anyone can read off the metric instead of a `_count` divergence nobody
 * is watching. (Checked: nothing in the cluster repo alerts on or dashboards
 * these series, so that divergence would never have been noticed.)
 */
export function launchHelloLabel(value: unknown): AppBlockLaunchHello {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
}

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

/**
 * The NON-`ok` verdicts of `withBlockScope`'s approved-status gate. Kept as a code-owned
 * union (not a free string) so the `reason` label stays a bounded 3-series set.
 *
 * 🔴 TWO OF THESE REFUSE AND ONE DOES NOT, which is why this is not called `…REFUSALS`:
 * `not_found` is counted and then SERVED. See the counter's own comment for the argument.
 */
/**
 * Which guard refused: the REST wrapper (`withBlockScope`) or the tRPC bridge
 * (`authorizeBlockBridgeToken`). Both read the SAME `BlockRevocation.isRevoked`, so a
 * series that could not tell them apart would leave you unable to say which half of the
 * surface a refusal came from.
 */
export const APP_BLOCK_REVOCATION_SURFACES = ['rest', 'bridge'] as const;
export type AppBlockRevocationSurface = (typeof APP_BLOCK_REVOCATION_SURFACES)[number];

/**
 * The blockInstanceId NAMESPACES a revocation refusal can name. Bounded on purpose — the
 * instance id itself is unbounded and must never become a label.
 *
 * 🔴 THE NAMESPACE IS THE LABEL THAT EARNS ITS KEEP. A revocation gap is always
 * namespace-shaped: clawgate #618 shipped a writer covering one namespace of five while
 * every comment claimed all of them, and later rounds found `page_` was really FIVE
 * mint shapes. A refusal counter split this way makes "this surface has never once
 * refused" a readable, falsifiable statement per namespace instead of one flat number.
 */
export const APP_BLOCK_REVOCATION_NAMESPACES = [
  'bki',
  'mbi',
  'bus_pub',
  'bus_view',
  'pdb',
  'page',
  'page_pubreq',
  'page_local',
  'other',
] as const;
export type AppBlockRevocationNamespace = (typeof APP_BLOCK_REVOCATION_NAMESPACES)[number];

/**
 * Bucket a blockInstanceId to its namespace. ORDER MATTERS: the `page_pubreq_` and
 * `page_local_` shapes are prefixed by `page_`, so they must be tested BEFORE it or they
 * collapse into it — which is exactly the collapse that hid the two uncovered dev-token
 * shapes from a prefix-granular guard.
 */
export function revocationNamespaceLabel(blockInstanceId: unknown): AppBlockRevocationNamespace {
  if (typeof blockInstanceId !== 'string') return 'other';
  if (blockInstanceId.startsWith('page_pubreq_')) return 'page_pubreq';
  if (blockInstanceId.startsWith('page_local_')) return 'page_local';
  if (blockInstanceId.startsWith('page_')) return 'page';
  if (blockInstanceId.startsWith('bus_pub_')) return 'bus_pub';
  if (blockInstanceId.startsWith('bus_view_')) return 'bus_view';
  if (blockInstanceId.startsWith('pdb_')) return 'pdb';
  if (blockInstanceId.startsWith('bki_')) return 'bki';
  if (blockInstanceId.startsWith('mbi_')) return 'mbi';
  return 'other';
}

export const APP_BLOCK_REST_APPROVAL_VERDICT_REASONS = [
  'not_approved',
  'not_found',
  'lookup_failed',
] as const;
export type AppBlockRestApprovalVerdictReason =
  (typeof APP_BLOCK_REST_APPROVAL_VERDICT_REASONS)[number];

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
 *   1. NEVER OBSERVE A ZERO. A leg that was not measured — a mark never taken
 *      (no token ever arrived, BLOCK_INIT never posted), a sub-millisecond delta
 *      that rounds to 0, or a hand-rolled client sending 0 — arrives as 0 or
 *      absent. A 0 in a latency histogram is indistinguishable from an instant
 *      leg and drags every percentile toward the bottom bucket, in the
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

/**
 * The `initPosts` gate — the count sibling of `launchSampleSeconds`, with the
 * same two rules and one extra.
 *
 * 🔴 1. DROP, NEVER CLAMP. A clamp folds junk onto the `+Inf` edge and pollutes
 *       `_sum` and the tail. Here that would be self-defeating rather than
 *       merely untidy: a clamped 5,000 lands in the top bucket and reads as
 *       "this launch waited out many re-post ticks", manufacturing the exact
 *       evidence the metric was added to test for.
 * 🔴 2. REJECT ZERO AND NON-POSITIVE. A launch that reached BLOCK_READY posted
 *       at least one BLOCK_INIT by construction, so a 0 is a broken counter,
 *       not a fast launch — and it would bias `le=1` upward, i.e. toward "the
 *       cadence is not the problem", the reassuring answer.
 * 🔴 3. REJECT NON-INTEGERS. This is a count. A fractional value can only come
 *       from a client that is not counting posts, so it carries no information
 *       and `Math.round`ing it would invent some.
 *
 * The client applies the same three gates (`boundedInitPosts`), deliberately —
 * this side is the one facing a public, client-controlled beacon body.
 */
export function launchInitPostsSample(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (!(value > 0)) return null;
  if (value > MAX_APP_BLOCK_LAUNCH_INIT_POSTS) return null;
  return value;
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
  bridgeMessagesTotal: Counter<string>;
  customComfyActualBuzz: Histogram<string>;
  customComfyWallclockSeconds: Histogram<string>;
  capLimitsDegradedTotal: Counter<string>;
  spendCapRejectionsTotal: Counter<string>;
  restApprovalVerdictsTotal: Counter<string>;
  revocationRefusalsTotal: Counter<string>;
  stepPriceCheckTotal: Counter<string>;
  launchTotalSeconds: Histogram<string>;
  launchPhaseSeconds: Histogram<string>;
  launchInitPostsTotal: Histogram<string>;
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
//   10   — BLOCK_READY_TIMEOUT_MS: the ceiling on ONE attempt's wait for
//          BLOCK_READY once init has started.
//   15   — TOKEN_WAIT_TIMEOUT_MS: the ceiling on ONE attempt's wait for a token.
//
// 🔴 A `launch_total` ABOVE 15s IS REACHABLE AND LEGITIMATE — do not read the
// top bucket as a bug signal. An earlier revision of this comment claimed a
// sample above 10s was "structurally impossible on the success path" because the
// ready timeout fires first. That is true of ONE ATTEMPT and false of a LAUNCH:
// the host emits exactly one `ok` for the whole bounded auto-retry sequence,
// whichever attempt produced it, so a success can legitimately total up to
// `worstReachableLaunchMs()` = 57s. `+Inf − le=15` therefore means "recovered
// slowly", which is a real and interesting population, not a broken emitter.
//
// 🟡 KNOWN LIMITATION — the 15-60s tail is ONE undifferentiated bucket. Every
// auto-retry-recovered launch lands in `+Inf` with no resolution between "16s"
// and "57s", so the histogram can say THAT a launch was slow-recovered but not
// how slow. Deliberate: extra edges up there would cost series on every app for
// a population that is rare by construction (it takes two failed attempts), and
// `_sum`/`_count` still give a usable mean for it. Revisit only if that bucket
// turns out to carry real volume.
const APP_BLOCK_LAUNCH_BUCKETS = [0.1, 0.25, 0.4, 0.6, 0.8, 1.2, 1.8, 2.5, 4, 6, 8, 10, 15];

/**
 * Upper sanity bound on a single launch sample, in seconds.
 *
 * 🔴 DERIVED FROM THE AUTO-RETRY BOUND, NOT PICKED — and the derivation is CODE,
 * in `worstReachableLaunchMs()` (`~/components/AppBlocks/pageBlockHostLogic`), not
 * this comment. A test asserts this cap exceeds it, so widening any of the five
 * host constants it reads fails loudly instead of silently walking past the cap.
 *
 * The arithmetic has been wrong in a comment twice: first at 30s ("well above
 * TOKEN_WAIT_TIMEOUT_MS (15s), the longest leg that can legitimately complete",
 * which assumed a launch is ONE attempt — it is not, the host emits one `ok` for
 * the whole bounded sequence), then at "~47s" (a sequence with two consecutive
 * `no_token`s, which `MAX_AUTO_REMINTS = 1` makes unreachable). The real worst
 * reachable success is 57s. 🔴 The margin here is therefore ~3s — deliberately
 * tight and test-guarded rather than padded.
 *
 * The 30s cap was dropping real slow successes in a slowness-correlated way,
 * trimming exactly the tail the metric exists to show. Mirrors
 * `MAX_LAUNCH_SAMPLE_MS` client-side.
 *
 * DROPPED, not clamped (see `launchSampleSeconds`).
 */
export const MAX_APP_BLOCK_LAUNCH_SECONDS = 60;

// ── launch INIT-POST-COUNT buckets ───────────────────────────────────────────
//
// 🔴 THE EDGES ARE THE HYPOTHESIS TEST, not a generic spread. The question this
// metric exists to answer is binary at `le=1`:
//
//   `le=1` share HIGH  -> most launches ack on the FIRST post, so `init_wait`
//                         is the block's own boot time and the re-post cadence
//                         is not the lever.
//   `le=1` share LOW   -> launches are waiting out re-post ticks, i.e. the
//                         cadence IS the lever and shortening it should move
//                         `init_wait` down.
//
// So 1 and 2 are both explicit edges — the whole discrimination lives in the
// gap between them, and a first bucket of `le=2` would merge exactly the two
// populations the field was added to separate. Above that the edges only need
// to show "waited a long time", so they widen fast.
//
// 14 finite edges + `+Inf` + `_sum` + `_count` = 17 series, and the histogram
// carries NO labels, so this is 17 series per pod flat — a rounding error
// against the ~864/pod the two launch-latency histograms already cost.
const APP_BLOCK_LAUNCH_INIT_POST_BUCKETS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 28, 40, 64];

/**
 * Upper sanity bound on a launch's BLOCK_INIT post count.
 *
 * 🔴 DERIVED, NOT PICKED — the derivation is CODE, in `worstReachableInitPosts()`
 * (`~/components/AppBlocks/pageBlockHostLogic`), and a test asserts this clears
 * it. Shortening the host's re-post schedule RAISES the reachable count, so a
 * cap chosen by eye starts dropping real samples the next time anyone tunes the
 * cadence — and it would drop the launches that posted the MOST, which are
 * exactly the quantization-bound ones the field exists to find. The metric would
 * then report "no quantization" by construction.
 *
 * DROPPED, not clamped (see `launchInitPostsSample`). Mirrors
 * `MAX_LAUNCH_INIT_POSTS` client-side.
 */
export const MAX_APP_BLOCK_LAUNCH_INIT_POSTS = 128;

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

  // ── postMessage BRIDGE message outcomes ──────────────────────────────────────
  //
  // 🔴 THE SERIES `renders_total` STRUCTURALLY CANNOT BE. `renders_total` fires
  // ONCE PER HOST MOUNT and reports the settled MOUNT outcome, so every failure
  // after BLOCK_READY is invisible to it — and every one of the bridge's five
  // silent drop paths lives after ready. Measured 2026-09-18: a `custom-generators`
  // gallery read was dead end-to-end while 100% of render series across all 11
  // rendering apps read `result=ok, error_class=none`, for the full 15-day
  // retention. A perfect green dashboard the entire time the defect was live. Do
  // not treat these two counters as overlapping: one grades the LAUNCH, this one
  // grades the CONVERSATION.
  //
  // 🔴 READ `handled` AS THE DENOMINATOR, NEVER THE ERROR COUNTS ALONE. A falling
  // `no_handler` rate and a falling traffic rate are the same observation without
  // it (the bare-count trap the `step_price_check` counter's `quoted`/`absent` pair
  // above exists to avoid). Alert on a RATIO.
  //
  // 🔴 `no_handler` IS NOT UNIFORMLY A BUG — read it WITH `host`. A page-only
  // message arriving at the model slot (`GET_VIEWER`, `GET_IMAGES_BY_IDS`,
  // `OPEN_IMAGE_UPLOAD`, …) is an EXPECTED refusal that the parity inventory
  // declares N/A for `IframeHost`; the same type unhandled on `PageBlockHost` is a
  // real missing bridge. The `host` label values are the parity inventory's own
  // file names precisely so the series joins to `INVENTORY[type][host]` with no
  // mapping table in between.
  //
  // Cardinality: (A+1) x (47+1) x 2 x 6 ~= 29,376 at A=50 approved apps, where
  // `boundAppBlockIdLabel` adds exactly one extra value, 'other' (it returns the
  // id or 'other', nothing else — do not copy the '+2' the launch histograms use,
  // which is wrong for the same reason). That is the largest App
  // Block label set in this module and it is the one number to re-derive before
  // adding a label here. It is acceptable only because BOTH multiplicands are
  // hard-bounded by code-owned sets — `type` by `boundBridgeMessageType` against
  // the protocol INVENTORY, `host`/`outcome` by zod enums on the beacon body — so
  // a scripted client cannot move it at all, and because in practice the reachable
  // product is far smaller (an app uses a handful of message types, on one host).
  // 🔴 DO NOT ADD `slot_id`, `block_instance_id`, OR ANY REQUEST-SCOPED FIELD:
  // prom-client retains every distinct label set in the Node heap forever across
  // ~130 scraped pods (the --max-old-space-size exit-139 OOM class). Attribution
  // beyond these four belongs in a log line.
  const bridgeMessagesTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_bridge_messages_total',
    "App Block host<-block postMessage bridge dispatch outcomes by app, message type, host, and outcome. handled = at least one registered handler was invoked (THE DENOMINATOR — read every other value as a ratio against it, never as a bare count); no_handler = this host registers no handler for the type, so a REQUEST-style message would hang to its SDK timeout (30s default / 120s workflow / 600s human-in-the-loop) — READ IT WITH `host`, because a page-only message refused by IframeHost is the DECLARED design (see hostHandlerParity INVENTORY) while the same type unhandled on PageBlockHost is a missing bridge; rate_limited = the 30 msg/sec inbound budget was exhausted; deduped = the same requestId arrived twice inside the 5s dedup window; no_token = a handler ran and refused because the block credential was falsy; validator_rejected = the BLOCK refused OUR reply at its own trust boundary and dropped it, so its request hangs to the SDK timeout — self-REPORTED by the block over BLOCK_MESSAGE_REJECTED, because this host cannot observe it (the SDK validator runs in the iframe after we have already replied, so we counted the same exchange `handled`), its `type` is the block->host REQUEST left hanging rather than the rejected *_RESULT reply, and it is NOT undercounted — the SDK carries no emit budget, so magnitude on this outcome is unbounded exactly as it is for no_handler and deduped. READ A ZERO PER-APP, NEVER FLEET-WIDE: the emitter ships inside each block's own bundle, so for a given app_block_id a zero means 'no rejections' OR 'this app has not shipped a carrying @civitai/blocks-react', and the series cannot tell you which. Other apps reporting does NOT settle it — the counter goes non-zero the moment the first rebuilt app hits a rejection, so a non-zero total is not evidence any OTHER app's zero is health. `type` is clamped to the code-owned protocol inventory (unknown -> 'other') and `app_block_id` to the approved-app set (unknown -> 'other'); this beacon is public and browser-reachable, so neither is ever taken raw from the body. NOT comparable to civitai_app_block_renders_total, which fires once per MOUNT and is structurally blind to everything after BLOCK_READY",
    ['app_block_id', 'type', 'host', 'outcome']
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
  //
  // 🔴 NOT ONLY THE customComfy BRIDGE ANY MORE, AND NOT ONLY REGISTRY-DERIVED
  // LABELS. Every arm that reserves a post-paid CEILING settles through the same
  // record, so these also carry the inline arm ({inline, __inline__}) and the
  // denylist-only PASS-THROUGH `kind:'step'` arm ({passthrough, __passthrough__}).
  // Both are CONSTANTS chosen precisely because those arms have no registry to
  // resolve an enum from — the pass-through `$type` set is open by construction —
  // so the bound holds, but "enum-resolved from the registry" is no longer the
  // reason it does. A new post-paid arm with constant labels adds one pair;
  // flipping `postPaidSettle` on a REGISTRY step entry instead adds one pair per
  // (step id × variant), because that persist site passes the resolved variant
  // and the step id rather than constants.
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

  // ── REST approved-status GATE verdicts ───────────────────────────────────────
  // Emitted by `withBlockScope`'s approved-status gate — one increment per REST
  // request whose verdict was NOT `ok`, by reason. `ok` and `dev_exempt` are not
  // counted: they are the steady state and would swamp the series.
  //
  // 🔴 READ THE `refused?` COLUMN BEFORE ALERTING ON THIS. Two of the three reasons
  // refuse and one deliberately does not, so `sum(rate(...))` across the label is a
  // number with no meaning — it adds requests that were turned away to requests that
  // were served. Always split by `reason`.
  //
  //   not_approved  — REFUSED, 403. The gate WORKING, and the ONLY branch that
  //                   carries the gate's value: every moderator takedown leaves a
  //                   row whose status is not `approved`. Expected to be zero most
  //                   days and to spike for exactly one token lifetime after a
  //                   takedown.
  //   not_found     — 🔴 SERVED, NOT REFUSED. A signature-valid token whose
  //                   (appId, blockId) resolves to no row is a HEALTHY app — a row
  //                   deleted or re-keyed mid-session, blockId drift, an id-minting
  //                   bug — so this branch carried all of the false-positive risk
  //                   and none of the value, and refusing on it would 404 a live
  //                   public endpoint with no toggle to pull. It is OBSERVED
  //                   instead: a non-zero rate here is the signal that the
  //                   id-resolution assumption is wrong and something upstream
  //                   needs fixing, NOT an authorization event and NOT an outage.
  //                   It is a separate series precisely so that it never has to be
  //                   inferred out of a combined "the gate refused something" number.
  //   lookup_failed — REFUSED, 503. The replica read threw. Infra, not policy;
  //                   fail-closed, because a read we cannot complete leaves us
  //                   unable to establish that the app is allowed to run at all.
  //
  // 🔴 ONE LABEL, `reason`, over a 3-value code-owned union → 3 series, TOTAL.
  // No `app_block_id`: this fires once per non-ok request with nothing caching or
  // rate-limiting it, and prom-client retains every distinct label set in the Node
  // heap forever across ~130 scraped pods. Attribution belongs in the caller's log
  // line — the same alert-on-the-metric / attribute-from-the-log split the two
  // counters above use, and it is why the `not_found` branch logs appId/blockId.
  const restApprovalVerdictsTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_rest_approval_verdicts_total',
    'Non-ok verdicts of the withBlockScope approved-status gate on App Block REST requests, by reason. NOT all refusals — split by reason before alerting: not_approved = the backing app_blocks row is not approved, REFUSED 403 (the gate enforcing a takedown); not_found = a signature-valid token resolved to no app_blocks row, SERVED (observe-only: a healthy app, counted so the false-positive rate is visible); lookup_failed = the replica read threw, and the outcome is ROUTE-DEPENDENT — 503 on the routes that fail closed, SERVED on the five that declare onApprovalLookupFailure. This counter carries ONLY `reason`, so it cannot itself tell refused from served on lookup_failed; which routes serve is the ledger LOOKUP_FAILURE_SERVE_RATIONALE in no-unguarded-block-rest-token.test.ts, and civitai_app_block_requests_total{endpoint,result} is the sibling series that carries endpoint',
    ['reason']
  );

  // ── REVOCATION REFUSALS ──────────────────────────────────────────────────────
  // 🔴 THIS MECHANISM WAS ENTIRELY UNOBSERVABLE UNTIL NOW, AND NOT BY DESIGN. The REST
  // revocation branch 403s and RETURNS before `recordScopeInvocation` registers its
  // `res.on('finish')` handler, so a revocation refusal could never write a
  // `block_scope_invocations` row — the audit surface everyone assumed covered it. The
  // result: no signal anywhere distinguished "revocation has never fired" from
  // "revocation is broken and silently serving", while three separate writers were added
  // to it across clawgate #618. A control nobody can tell has ever fired is a control
  // nobody can defend.
  const revocationRefusalsTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_revocation_refusals_total',
    'Block-token requests refused because BlockRevocation.isRevoked returned true, by guard surface and blockInstanceId namespace. surface: rest = withBlockScope (403), bridge = authorizeBlockBridgeToken (tRPC FORBIDDEN). namespace buckets the instance id (bki/mbi/bus_pub/bus_view/pdb/page/page_pubreq/page_local/other) — the id itself is unbounded and is deliberately NOT a label; attribute individual refusals from the logs. A flat zero on a namespace means either nothing has been revoked there or that namespace is not reached by any revocation writer, and those are different bugs — read it against the writer in blocks/publisher-ban-revocation.service.ts. isRevoked FAILS OPEN on a Redis error, so this counter cannot see a refusal that a Redis incident suppressed',
    ['surface', 'namespace']
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
  // 🔴 `over` USED TO MEAN "billed above the RESERVATION", AND ITS DESCRIPTION
  // SAID "the declared price is wrong". Those are different claims, and the gap
  // between them made this counter blind to exactly what it advertised.
  // `reserveBuzz` is `max(declaredBuzz, quotedBuzz)` — it has already absorbed
  // the orchestrator's live quote — so a step declared at 1 and quoted+billed at
  // 4 computed `4 - 4 = 0` and was recorded `exact`. Measured on the live
  // platform: two consecutive real `chat-completion` sends, declared 1, billed
  // 4, `exact` both times.
  //
  // The two questions are now separate values rather than one conflated one:
  //
  //   exact         — billed ≤ the declared price AND ≤ the reservation. Healthy,
  //                   and PROOF the detector is live.
  //   over          — billed above the DECLARED price, but within the
  //                   reservation, because the submit's own `whatif` quote had
  //                   already raised the reserve. Costs no money and loosens no
  //                   cap: the registry's asserted price is simply not the real
  //                   one.
  //   over_reserved — billed above the RESERVATION. This is the expensive one:
  //                   all three cap counters were short by the difference until
  //                   the correction ran, so the per-app abuse ceiling was that
  //                   much looser. Rare by construction, because the reserve is
  //                   quote-backed.
  //   absent        — no numeric cost on the submit snapshot, so nothing could
  //                   be compared. The state that used to be indistinguishable
  //                   from `exact`.
  //
  // …plus the ESTIMATE phase, which is a price check too — it is where the block
  // learns what a call will cost:
  //
  //   estimate_quoted — the estimate got a live orchestrator quote.
  //   estimate_absent — it could not, and fell back to the declared price. The
  //                     block was shown a number nothing re-measured.
  //
  // 🔴 THE PAIR IS THE POINT. `estimate_absent` alone is unreadable: a flat zero
  // is indistinguishable from an estimate path that never executes. Read the
  // RATIO against `estimate_quoted`, never the bare count.
  //
  // 🔴 ALERT ON `over_reserved`, NOT ON `over`. `over` is expected to sit at ~100%
  // for any entry whose real price is usage-based — `chat-completion` is one
  // (its live price moves with the model and the token budget, while its declared
  // constant is the floor the orchestrator will not go below), so alerting on
  // `over` there would be a permanently-red gate and would train everyone to
  // ignore it. `over` is a REPORT that a declared constant does not describe
  // reality; `over_reserved` is the thing that costs money. Read
  // `outcome="exact"` to confirm the check runs at all; investigate a rising
  // `absent` or a falling `estimate_quoted`/`estimate_absent` ratio — and read
  // `absent` per `step` label, because its meaning inverts on `__passthrough__`
  // (see the help text).
  //
  // Cardinality: `step` is drawn from the code-owned registry keys (never client
  // input — the wire enum derives from those same keys, so an unregistered id
  // cannot reach here) PLUS the single constant `__passthrough__`, which the
  // pass-through `kind:'step'` arm emits under precisely because ITS `$type` set
  // is open by construction; `outcome` is a closed 7-value set. Bounded and small.
  const stepPriceCheckTotal = getOrCreateCounter(
    reg,
    'civitai_app_block_step_price_check_total',
    "App Block `kind:'step'` price checks, by step id and outcome. Only the post-billing submit outcomes are prepaidFixed-gated; the fail-closed absent and the estimate-phase outcomes fire for any kind:'step' request. Submit phase: exact = billed within both the declared price and the reservation; over = billed above the DECLARED price but within the quote-backed reservation (the declared constant is wrong; no money or cap impact — expected to be ~100% for a usage-priced step, do NOT alert on it); over_reserved = billed above the RESERVATION, so every cap counter was short until corrected (ALERT ON THIS); absent = READ THE step LABEL FIRST, THE TWO MEANINGS ARE OPPOSITE: on a REGISTRY step id, either the submit was refused because the orchestrator returned no price quote (no spend, no generation - triage as availability) or a billed submit carried no numeric cost; on step=\"__passthrough__\" it means only that the submit was not refused FOR LACK OF A QUOTE - that arm falls back to the app's own declared maxBuzz and CARRIES ON, so a generation MAY have run with its Buzz ceiling resting on a number the app supplied. It fires before every cap and before the real submit, so the same `$type` being rejected outright by the orchestrator also lands here. Read it against quoted; this counter cannot separate the two causes - only whether a submit produced a workflow does, and the nearest series for that is civitai_app_block_customcomfy_wallclock_seconds{engine=\"passthrough\"} (one sample per pass-through workflow that reached terminal - a lower bound, not joinable to this counter per event). quoted = the pass-through submit got a live orchestrator quote; it is absent's denominator and exists so absent cannot be read alone, since a bare count falls when submit volume falls. Estimate phase: estimate_quoted = the block was shown a live orchestrator quote; estimate_absent = the quote failed and it was shown the declared price instead (read as a ratio against estimate_quoted, never alone)",
    ['step', 'outcome']
  );

  // ── LAUNCH LATENCY — TWO histograms, deliberately, not one ──────────────────
  //
  // 🔴 THE SPLIT IS THE CARDINALITY DESIGN, not a stylistic choice.
  //
  // Count a histogram label set as 16 SERIES, not 15: 13 finite bucket edges
  // + `+Inf` + `_sum` + `_count`. And `app_block_id` spans ~52 values at A=50
  // approved apps, because `boundAppBlockIdLabel` adds BOTH 'dev' and 'other'.
  //
  // A single combined {app_block_id, phase} histogram would then be
  // 52 × 2 × 16 = 1,664 series PER POD, across ~130 scraped dp-prod pods — and
  // prom-client retains every distinct label set in the Node heap forever (the
  // --max-old-space-size exit-139 OOM class). Split as below it is
  // 52 × 16 = 832 plus 2 × 16 = 32, i.e. ~864/pod at full app saturation
  // (an earlier revision said 795 — it undercounted both factors), in line with
  // the existing
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
  // 🔴 THERE IS NO CROSS-ORIGIN `frame_fetch` PHASE, DELIBERATELY. Both phases
  // here are HOST-side, measured from the host's own marks, so both are observed
  // for every successful launch on every app — no header dependency, no coverage
  // denominator to publish, no biased subset. A phase for the block-frame fetch
  // was designed and then dropped: without `Timing-Allow-Origin` the parent's
  // `responseEnd` for a cross-origin subframe is the frame's LOAD event, not the
  // document response, so it measures roughly what `total` already measures —
  // and the entry does not exist at all until that load fires, which an SPA
  // block posting BLOCK_READY at app-mount typically outruns. The full reasoning
  // and the re-add seam are in launchTimings.ts.
  const launchPhaseSeconds = getOrCreateHistogram(
    reg,
    'civitai_app_block_launch_phase_seconds',
    'App Block launch PHASE seconds by phase (token_mint = host mount -> first token; init_wait = first BLOCK_INIT -> BLOCK_READY) and by `hello`. Both phases are host-side. 🔴 The phases are PARALLEL legs of one race (the iframe mounts before any token exists) and do NOT sum to launch_total. There is deliberately no cross-origin frame-fetch phase — see launchTimings.ts. 🔴 `hello` = did the GUEST announce BLOCK_HELLO during this launch (yes|no|unknown) — NOT whether the accelerator fired an extra post; see launchHelloLabel. `unknown` = the beacon carried no boolean, i.e. a browser bundle older than the label; it is a real bucket rather than a drop, so `sum without (hello)` recovers exactly the pre-label series and no coverage is lost. EXCLUDE `unknown` from any yes-vs-no contrast, and watch its share: a large or growing `unknown` means stale clients are a big slice of traffic and the stratified read is thin. It exists because BLOCK_HELLO short-circuits the very wait the host re-post cadence governs, so `init_wait` must be read WITHIN a `hello` value: comparing the unstratified aggregate across a cadence change mixes two populations and dilutes toward the null. 🔴 RETROACTIVE LIMIT: samples recorded before this label shipped carry no `hello` and can never be stratified, so a post-vs-pre read is only sound for hello="no"; the within-period hello="no" vs hello="yes" contrast is the clean one. 🔴 RETROACTIVE LIMIT applies only to pre-label data; a stale CLIENT is visible as hello="unknown" rather than silently missing, which matters because the beacon route runs no client-version gate so old browser bundles persist for as long as their tab does.',
    ['phase', 'hello'],
    APP_BLOCK_LAUNCH_BUCKETS
  );

  // 🔴 THE DISCRIMINATOR FOR `init_wait`, and the reason it is a histogram of a
  // COUNT rather than another duration.
  //
  // `launch_phase_seconds{phase="init_wait"}` has a pronounced 0.4-0.6s mode.
  // Two mutually exclusive mechanisms produce an identical curve there — the
  // host's BLOCK_INIT re-post quantization, and blocks that simply boot in that
  // time — and NO duration metric can separate them, because the quantity that
  // differs is how many times the host had to ask. This does separate them, in
  // one query: the `le=1` share.
  //
  // 🔴 NO LABELS AT ALL, deliberately. Not `app_block_id` (that is the ~52x
  // cardinality note above) and not `phase` (there is one phase this can be
  // about). The reading is a fleet-level share; per-app attribution stays in the
  // log, the same split the phase histogram already makes.
  const launchInitPostsTotal = getOrCreateHistogram(
    reg,
    'civitai_app_block_launch_init_posts',
    'BLOCK_INIT posts the host made before the block acknowledged with BLOCK_READY, per successful non-secondary launch. 🔴 THIS IS THE DISCRIMINATOR FOR `init_wait`: the share at `le=1` says whether launches ack on the first post (so `init_wait` is the block\'s own boot time and the re-post cadence is not the lever) or wait out re-post ticks (so the cadence IS the lever). A `le=1` share that RISES after a cadence change, at unchanged or lower `init_wait`, is the intended effect. Read as a share, never as a raw count. 🔴 THE DENOMINATOR IS THIS HISTOGRAM\'S OWN `_count`, NEVER `launch_total_seconds_count` — the two DIVERGE, and not randomly. A launch is counted in `launch_total_seconds` but NOT here whenever the post count is unusable: a block that posts BLOCK_READY before the host ever sent an init (count 0 — reachable today, e.g. a hand-rolled host shim acking while the token is still resolving), or a manual-retry storm pushing the count past the cap. The first case is FAST, no-quantization traffic, so dividing by the larger series subtracts it from the numerator but not the denominator and UNDERSTATES the `le=1` share — i.e. it makes the data look more quantized than it is, which is the direction that flatters the cadence change. Use `civitai_app_block_launch_init_posts_count`, AND read it within a single `hello` value. 🔴 `hello` = did the GUEST announce BLOCK_HELLO during this launch (yes|no|unknown) — NOT whether the accelerator fired; see launchHelloLabel. `unknown` is a stale browser bundle: keep it out of any yes-vs-no contrast. Stratifying matters most here: `hello="no"` is the population whose first-post-sufficiency the re-post cadence actually governs, so the `le=1` share AMONG hello="no" is the mechanism read, while the pooled share is dominated by accelerator apps. 🔴 RETROACTIVE LIMIT: pre-label samples carry no `hello` and cannot be stratified. A beacon with no boolean is labelled `unknown` — never `no`, and never dropped.',
    ['hello'],
    APP_BLOCK_LAUNCH_INIT_POST_BUCKETS
  );

  return {
    requestsTotal,
    requestDurationSeconds,
    rendersTotal,
    bridgeMessagesTotal,
    customComfyActualBuzz,
    customComfyWallclockSeconds,
    capLimitsDegradedTotal,
    spendCapRejectionsTotal,
    restApprovalVerdictsTotal,
    revocationRefusalsTotal,
    stepPriceCheckTotal,
    launchTotalSeconds,
    launchPhaseSeconds,
    launchInitPostsTotal,
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
  initWaitMs?: unknown;
  /** A COUNT, not a duration — see `launchInitPostsSample`. */
  initPosts?: unknown;
  /** BOOLEAN stratifier — see `launchHelloLabel`. Absent is NOT `false`. */
  hello?: unknown;
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

    const { launchTotalSeconds, launchPhaseSeconds, launchInitPostsTotal } =
      ensureRegisterAppBlockRuntimeMetrics();
    launchTotalSeconds.observe({ app_block_id: appBlockIdLabel }, total);

    // 🔴 TOTAL — every launch gets a bucket, including `unknown`. This must NOT
    // become a gate: dropping a sample whose `hello` is absent is a coverage
    // regression on an existing metric, and one correlated with slow launches.
    // See `launchHelloLabel`.
    const hello = launchHelloLabel(timings.hello);

    const phases: Array<[AppBlockLaunchPhase, unknown]> = [
      ['token_mint', timings.tokenMintMs],
      ['init_wait', timings.initWaitMs],
    ];
    for (const [phase, ms] of phases) {
      const seconds = launchSampleSeconds(ms);
      if (seconds === null) continue;
      launchPhaseSeconds.observe({ phase, hello }, seconds);
    }

    // Behind the same `total` anchor as the phases above, deliberately: a post
    // count with no end-to-end duration to interpret it against is an orphan,
    // and the reader's whole question is "how many posts for THAT init_wait".
    const initPosts = launchInitPostsSample(timings.initPosts);
    if (initPosts !== null) launchInitPostsTotal.observe({ hello }, initPosts);
  } catch {
    /* instrument-only — never let a metrics error touch the beacon response */
  }
}

/**
 * The closed outcome set for `civitai_app_block_step_price_check_total`. Keeping
 * it a union (rather than a bare string) is what bounds the label cardinality at
 * the type level — a caller cannot invent an eighth value.
 */
export type StepPriceCheckOutcome =
  | 'exact'
  | 'over'
  | 'over_reserved'
  | 'absent'
  | 'quoted'
  | 'estimate_quoted'
  | 'estimate_absent';

/**
 * Fail-soft emit of ONE step price check.
 *
 * 🔴 TWO CALL PHASES, AND THEY DIFFER IN EVERY WAY THAT MATTERS. This docstring
 * used to say "called from the step submit path on EVERY submit, after the money
 * has already moved" — that is now only half true, and the missing half is the
 * dangerous one to assume:
 *
 *   - SUBMIT, POST-BILLING (`exact` / `over` / `over_reserved`) — one emit per
 *     billed submit, AFTER the money has moved, gated on
 *     `plan.correctReservationOverage` and therefore on `prepaidFixed`.
 *   - SUBMIT, EITHER SIDE OF BILLING (`absent`) — 🔴 TWO DIFFERENT SITES SHARE
 *     THIS VALUE, AND THEY HAVE OPPOSITE POLARITY. One is post-billing (the submit
 *     succeeded but its snapshot carried no numeric cost, so no comparison was
 *     possible). The other is the FAIL-CLOSED no-quote path: the orchestrator
 *     returned no price, so the submit is REFUSED, nothing is reserved, no
 *     generation happens, and this fires before any money exists and outside the
 *     `correctReservationOverage` gate. A spike in `absent` is therefore far
 *     more likely to mean SUBMITS ARE BEING REFUSED than a bookkeeping gap —
 *     triage it as an availability signal first. (Splitting the two is the
 *     obvious improvement and is deliberately not done here: it would change a
 *     label's meaning in the same change that already widened the set.)
 *     🔴 The fail-closed site is NOT mode-gated either — it sits above the
 *     `correctReservationOverage` block — so the same caveat as the estimate
 *     bullet applies: it is `prepaidFixed`-only today because registry load
 *     rejects every other mode, not because this site checks.
 *   - 🔴 SUBMIT, PRE-BILLING, ON THE PASS-THROUGH ARM (`quoted` / `absent`,
 *     always with `step: '__passthrough__'`) — A THIRD SITE, AND ITS `absent`
 *     HAS THE OPPOSITE POLARITY TO THE FAIL-CLOSED ONE ABOVE. The pass-through
 *     `kind:'step'` arm does NOT refuse on a missing quote: it reserves the
 *     app's declared `maxBuzz` and proceeds. So there `absent` means only that
 *     the submit was not refused FOR LACK OF A QUOTE — a generation MAY have run
 *     with its ceiling resting on the app's own number. ⚠️ It is NOT a statement
 *     that one did: the emit sits inside the quote, ahead of the static gate,
 *     every reservation leg and the real submit, so an orchestrator that
 *     rejects the `$type` outright lands here too with nothing having run. The
 *     triage instruction in the bullet above is wrong for this arm, and the
 *     `step` label is what tells the two sites apart. 🔴 THIS COUNTER CANNOT
 *     SEPARATE THE TWO CAUSES — only whether a submit produced a workflow does,
 *     and the nearest series for that is
 *     `civitai_app_block_customcomfy_wallclock_seconds{engine="passthrough"}`:
 *     one sample per pass-through workflow that reached terminal, because the
 *     record it settles from is persisted only after a workflow exists. A LOWER
 *     BOUND, not a join — it needs a terminal observation, drops a sample above
 *     `MAX_CUSTOMCOMFY_WALLCLOCK_SECONDS` (600s, well past its 240s top bucket,
 *     so a slow gen IS still observed), and carries no label tying it to an
 *     individual `absent`. `quoted` is its success half and
 *     exists so `absent` has a denominator: without a pair, `absent` falls when
 *     submit volume falls, which reads as healthy. Not gated on billing mode
 *     (that arm has none).
 *   - ESTIMATE (`estimate_quoted` / `estimate_absent`) — one emit per estimate,
 *     BEFORE any spend exists, and NOT gated on billing mode: it fires for any
 *     `kind:'step'` estimate. Unreachable for a non-`prepaidFixed` entry today
 *     (registry load rejects every other mode), so the counter's
 *     "prepaidFixed" framing still holds in practice — but the first
 *     `timeBounded` entry would emit an estimate half with no submit-side
 *     counterpart, and the `estimate_quoted : estimate_absent` ratio would then
 *     blend a mode the submit half never reports on. Gate it here, or widen the
 *     label, when that day comes.
 *
 * 🔴 DO NOT ADD A POST-BILLING SIDE EFFECT BESIDE THIS CALL. Only the three
 * outcomes in the first bullet are reached with money behind them; the estimate
 * phase, the fail-closed `absent` and the pass-through pair all run before any
 * spend exists.
 *
 * 🔴 Emitted unconditionally within each phase — including `outcome: 'exact'` —
 * so a flat divergence line can be told apart from a detector that never ran.
 * See the counter's definition above for why that distinction is load-bearing.
 *
 * 🔴 TOTAL, like every emitter in this module. On the submit path it reports on
 * an already-billed submit, so a metrics error must never turn a successful
 * generation into a 500; on the estimate path it must never turn a working quote
 * into an error.
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
 * Fail-soft emit of one revocation refusal. Called from BOTH guards that read
 * `BlockRevocation.isRevoked` — `withBlockScope` (`block-scope.middleware.ts`) and
 * `authorizeBlockBridgeToken` (`blocks/block-bridge-auth.service.ts`).
 *
 * 🔴 TOTAL, like every emitter here: the refusal has already been decided by the time
 * this runs, and a metrics error must not convert a chosen 403 into an uncaught 500.
 *
 * COST: one in-heap counter increment, only on the refusal path. A fleet with nothing
 * revoked emits zero.
 */
export function recordBlockRevocationRefusal(
  surface: AppBlockRevocationSurface,
  blockInstanceId: unknown
): void {
  try {
    const { revocationRefusalsTotal } = ensureRegisterAppBlockRuntimeMetrics();
    revocationRefusalsTotal.inc({
      surface,
      namespace: revocationNamespaceLabel(blockInstanceId),
    });
  } catch {
    /* instrument-only — never let a metrics error change a refusal into a 500 */
  }
}

/**
 * Fail-soft emit of one non-`ok` REST approved-status GATE verdict. Called from
 * `withBlockScope` (`block-scope.middleware.ts`).
 *
 * 🔴 TOTAL, like every emitter in this module, and here the reason is sharper than
 * usual: the thing it instruments is an authorization gate on the block REST surface,
 * and two of its three reasons are decided refusals. If a metrics error propagated, a
 * verdict the gate had already settled would leave as an uncaught 500 instead of the
 * 403/503 it chose — or, on `not_found`, would turn a request the gate decided to SERVE
 * into a 500. Either way the observability would change the response it exists to
 * observe.
 *
 * COST: one in-heap counter increment on a path that has already left the happy case. An
 * APPROVED app never reaches here, so the steady state on a healthy fleet is zero emits.
 */
export function recordBlockRestApprovalVerdict(reason: AppBlockRestApprovalVerdictReason): void {
  try {
    const { restApprovalVerdictsTotal } = ensureRegisterAppBlockRuntimeMetrics();
    restApprovalVerdictsTotal.inc({ reason });
  } catch {
    /* instrument-only — never let a metrics error change the response the gate chose */
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
