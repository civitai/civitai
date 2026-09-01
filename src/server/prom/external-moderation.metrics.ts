// EXTERNAL PROMPT-MODERATION observability — the timer on `extModeration.moderatePrompt`.
//
// WHY this exists: `moderatePrompt` is an OUTBOUND HTTP call to a third-party classifier that runs
// INLINE and SERIALLY on the generation submission path (`generateFromGraph` → `auditPromptServer` →
// here). It is bounded by `AbortSignal.timeout(EXTERNAL_MODERATION_TIMEOUT_MS)` (default 5 s), and it
// is FAIL-SOFT: the caller catches, logs, and proceeds with `flagged:false`. Those two properties
// together are what made it invisible. Nothing timed it, nothing counted its failures, and because a
// failure is swallowed, a fully-down moderation gateway and a healthy one look identical from every
// instrument the app had — the only trace was a one-line Axiom event per failure, which carries no
// duration and cannot be aggregated into a rate or a quantile.
//
// So three questions that decide whether this call is a latency problem had no answer at all:
//   1. how long does a moderation call take, per call;
//   2. how often does it fail (i.e. how often is the secondary moderation layer silently absent);
//   3. how often does it reach its abort deadline, as opposed to merely being slow.
// This module answers all three with one histogram plus one counter for the not-configured case.
//
// SCOPE. Recorded inside `moderatePrompt` itself, which is the LOWEST funnel — every caller reaches
// it and none can bypass it. Instrumenting a level up (at `auditPromptServer`) would have blended the
// regex audit, the benign-phrase Redis reads and the ClickHouse/notification work into the same
// number, none of which is the external call.
//
// Imports the prom helpers from `@civitai/telemetry/client` DIRECTLY rather than through
// `~/server/prom/client`, matching `model-moderation.metrics.ts` and unlike
// `orchestrator-submit-metrics.ts`. Both register onto the same prom-client default registry that
// /api/metrics scrapes, so the choice is invisible in the output — but `~/server/prom/client`
// constructs the pg pool gauges at module load, and this module is reachable from a cron job
// (`audit-remix-sources`) and from the deliberately-light `moderation.ts`. The lighter edge keeps
// that import graph unchanged.
import { registerCounterWithLabels, registerHistogram } from '@civitai/telemetry/client';

/**
 * WHICH moderation population an observation belongs to. Bounded and closed — never derived from
 * anything a user or the upstream classifier controls.
 *
 * The label is load-bearing rather than decorative. `moderatePrompt` is reached from two very
 * different kinds of caller, and mixing them makes the headline figure meaningless:
 *
 * - `generate`    — the request-path prompt gate reached from `orchestrator.generateFromGraph`.
 *                   🔴 That is EVERY `GenerationSurface` EXCEPT `preset` — `onsite`, `api` AND
 *                   `block` (the App Blocks bridge) — because `submitSourceForSurface` maps
 *                   everything but `preset` to `generate`. Do not read a rise here as on-site
 *                   generator latency: App Blocks submissions are in it too. An ABSENT surface
 *                   falls to `other`, never to here. This is the population the metric exists to
 *                   size: the number to divide against that procedure's own wall time.
 * - `preset`      — the SAME `generateFromGraph` code reached through preset/comics generation,
 *                   which includes the `process-enqueued-comic-panels` CRON JOB. Split out for
 *                   exactly the reason its sibling on the submit metric is: a background job blended
 *                   into `generate` would corrupt the one division this metric supports.
 *                   🔴 That cron makes TWO external-moderation calls per panel and BOTH are labelled
 *                   here: its explicit pre-submit `auditPromptServer` gate, which declares
 *                   `moderationSource: 'preset'` by hand, and the one inside `submitPresetImageGen`
 *                   → `generateFromGraph`, which derives the same value from surface `preset`. So a
 *                   per-panel rate on this series is 2× the panel rate, by construction. (Until the
 *                   round-1 fix the explicit gate declared nothing and fell to `other`, which halved
 *                   this series' count for that cron and inflated `other` by the same amount.)
 * - `remixAudit`  — the `audit-remix-sources` background job, which calls `moderatePrompt` directly
 *                   rather than through `auditPromptServer`. Batch work, no user waiting on it.
 * - `other`       — every other `auditPromptServer` caller (App Blocks host-side audits, prompt
 *                   enhancement, shared content-safety). The DEFAULT, so a caller that declares
 *                   nothing can never silently inflate `generate`.
 *
 * 🔴 `other` is a genuine mixture, not a residue worth attributing: it is deliberately NOT split
 * further, because doing so means threading a source through `AuditPromptOptions` to nine call
 * sites. If a figure for one of those funnels is ever needed, that plumbing is the change — do not
 * read `other` as any single path.
 */
export type ExternalModerationSource = 'generate' | 'preset' | 'remixAudit' | 'other';

/**
 * Runtime narrowing for the `source` label.
 *
 * ⚠️ THE RATIONALE HERE WAS WRONG TWICE and is corrected rather than deleted, because the clamp
 * itself is worth keeping. It used to name the field `AuditPromptOptions.source` (it is
 * `moderationSource`) and justify itself by "an options object that call sites build by spread" —
 * but NO production caller spreads: all nine `auditPromptServer` call sites build an explicit object
 * literal, so excess-property checking does apply to every one of them, and spread appears only in
 * tests. That argument was fiction.
 *
 * THE REAL REASON. `moderatePrompt` is EXPORTED (`extModeration.moderatePrompt`) and its second
 * argument is reachable from any future caller, including one outside the `auditPromptServer` funnel
 * — `audit-remix-sources.ts` already is one. The type is a compile-time guarantee about the callers
 * that exist today under `tsc`, and two populations sit outside that: values that arrive already
 * widened to `string` (a cast, a `JSON.parse`, an `as never` in a test), and the test tree, which
 * `tsconfig.json` EXCLUDES (`src/**\/__tests__/**`) and where a helper CAN spread. What the clamp
 * buys is that none of those can mint an unbounded label value on a hot-path histogram — prom-client
 * retains every distinct label set in the Node heap forever, across ~130 scraped pods, so one stray
 * string is a cardinality incident with a green suite and no error anywhere.
 */
const EXTERNAL_MODERATION_SOURCES: ReadonlySet<string> = new Set<ExternalModerationSource>([
  'generate',
  'preset',
  'remixAudit',
  'other',
]);

export function clampExternalModerationSource(source: unknown): ExternalModerationSource {
  return typeof source === 'string' && EXTERNAL_MODERATION_SOURCES.has(source)
    ? (source as ExternalModerationSource)
    : 'other';
}

/**
 * `ok` = the classifier answered and the response was parsed. `timeout` = the call was cut by its own
 * `AbortSignal.timeout(EXTERNAL_MODERATION_TIMEOUT_MS)` deadline. `error` = every other failure — a
 * non-2xx from the classifier, a connection failure, a malformed body.
 *
 * The `timeout`/`error` split is the point of the label, not a refinement of it: from the caller's
 * side both are "fail soft, proceed unmoderated", but they cost completely different amounts of wall
 * time (a full deadline vs. an immediate reject) and they call for opposite responses (re-size the
 * deadline vs. fix or route around the gateway).
 */
export type ExternalModerationOutcome = 'ok' | 'error' | 'timeout';

/**
 * A fired abort deadline, as distinct from any other failure.
 *
 * `AbortSignal.timeout()` surfaces as a DOMException named `TimeoutError`; a composed or manual
 * abort surfaces as `AbortError`. undici nests the original under `.cause`, so walk a short chain
 * rather than testing only the outermost error.
 *
 * 🔴 There is an equivalent private predicate in `workflows.ts` (`isOrchestratorReadTimeout`). It was
 * deliberately not consolidated with this one: it is module-private to a heavy orchestrator module,
 * and importing across that boundary to reach it would pull the orchestrator client's import graph
 * into `moderation.ts`, which is imported by a cron job and today pulls in nothing but `env`.
 */
export function isAbortDeadlineError(e: unknown): boolean {
  let cur = e as { name?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (cur.name === 'TimeoutError' || cur.name === 'AbortError') return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/**
 * 10 ms → 20 s, straddling the `EXTERNAL_MODERATION_TIMEOUT_MS` deadline (default 5 s, env-clamped to
 * [100 ms, 60 s]).
 *
 * THE LOW END exists because this is a single outbound HTTPS POST whose healthy population lives in
 * tens-to-hundreds of milliseconds. The whole reason to time it is to apportion a per-call budget of
 * that size, so a bucket set whose first boundary sat at 0.5 s would put the entire healthy
 * population in one bucket and answer nothing.
 *
 * 🔴 THE TOP END IS THE PART THAT IS EASY TO GET WRONG, AND `5` IS NOT THE TOP. A boundary is
 * inclusive (`le`), and `AbortSignal.timeout(5000)` fires AT 5000 ms — so an aborted call is observed
 * at slightly MORE than 5 s and lands in `le=7.5`, while a call that answered just under the deadline
 * lands in `le=5`. Those two are the distinction this metric exists to draw ("is the gateway slow, or
 * are we cutting it off?"), and they are only distinguishable because a finite boundary sits ABOVE
 * the cap. A family whose top finite bucket sat AT the cap would drop every capped call into `+Inf`
 * together with every pathological one, saturating exactly the region being asked about — the
 * boundary a bucket-based quantile cannot see past.
 *
 * `10` and `20` carry two further things: the deadline is an env knob that can be re-tuned upward, so
 * the tail keeps some resolution if it is; and under the default cap a NON-EMPTY `+Inf` is itself a
 * finding (nothing should ever exceed the deadline by 15 s — that would mean the abort did not take
 * effect), which a bucket set stopping at the cap could not express.
 */
const EXTERNAL_MODERATION_BUCKETS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 20,
] as const;

const durationHistogram = registerHistogram({
  name: 'external_moderation_duration_seconds',
  help:
    'Duration (seconds) of an external prompt-moderation call (extModeration.moderatePrompt) as the ' +
    'CALLER experiences it: the whole outbound classifier request, including body parse. Labeled by ' +
    'source (generate|preset|remixAudit|other) + outcome (ok|error|timeout). The call sits inline and ' +
    'serially on the generation submission path and is FAIL-SOFT, so a rising error rate here is ' +
    'invisible to every user-facing signal — it means prompts are being generated with only the local ' +
    'regex gate applied. outcome=timeout is the EXTERNAL_MODERATION_TIMEOUT_MS deadline firing; those ' +
    'observations land just above the cap (le=7.5 at the 5s default), never in le=5. Filter on source ' +
    'before attributing a figure to a procedure: source=generate is the orchestrator.generateFromGraph ' +
    'prompt gate for EVERY surface except preset — onsite, api AND block (App Blocks), so it is not ' +
    'on-site-only — while remixAudit is batch work with nobody waiting.',
  labelNames: ['source', 'outcome'] as const,
  buckets: [...EXTERNAL_MODERATION_BUCKETS],
});

const skippedCounter = registerCounterWithLabels({
  name: 'external_moderation_skipped_total',
  help:
    'Count of extModeration.moderatePrompt calls that returned without contacting the classifier ' +
    'because EXTERNAL_MODERATION_ENDPOINT / EXTERNAL_MODERATION_TOKEN are not configured. Labeled by ' +
    'source. Deliberately a SEPARATE counter rather than a fourth outcome on the duration histogram: ' +
    'these calls do no I/O, so folding their ~0s observations in would drag every quantile toward ' +
    'zero and make the healthy latency distribution unreadable. It exists at all because otherwise a ' +
    'zero rate on the histogram is indistinguishable from a deployment where external moderation is ' +
    'switched off — the reassuring reading and the alarming one would look the same.',
  labelNames: ['source'] as const,
});

/**
 * Record ONE external moderation call — exactly one call per `moderatePrompt` invocation that
 * actually issued a request, whichever way it settled. Cheap + TOTAL (never throws): it runs on the
 * generation hot path, so a metrics-layer hiccup must not be able to fail a generation.
 */
export function observeExternalModeration(
  source: ExternalModerationSource,
  outcome: ExternalModerationOutcome,
  durationSeconds: number
): void {
  try {
    durationHistogram.observe(
      { source: clampExternalModerationSource(source), outcome },
      durationSeconds
    );
  } catch {
    // Observability must never break the moderation path. Swallow any prom-client error.
  }
}

/**
 * Record ONE `moderatePrompt` call that short-circuited because the integration is not configured.
 * Cheap + TOTAL (never throws), same reasoning as above.
 */
export function recordExternalModerationSkipped(source: ExternalModerationSource): void {
  try {
    skippedCounter.inc({ source: clampExternalModerationSource(source) });
  } catch {
    // Observability must never break the moderation path. Swallow any prom-client error.
  }
}
