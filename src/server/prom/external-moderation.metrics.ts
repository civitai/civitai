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
 * - `generate`    — the request-path audits inside `orchestrator.generateFromGraph`.
 *                   🔴 That is EVERY `GenerationSurface` EXCEPT `preset` — `onsite`, `api` AND
 *                   `block` (the App Blocks bridge) — because `submitSourceForSurface` maps
 *                   everything but `preset` to `generate`. Do not read a rise here as on-site
 *                   generator latency: App Blocks submissions are in it too. An ABSENT surface
 *                   falls to `other`, never to here. This is the population the metric exists to
 *                   size: the series to divide against that procedure's own wall time.
 *                   🔴 IT COUNTS CALLS, NOT SUBMISSIONS — the same caveat `preset` carries below,
 *                   and it applies here too. `generateFromGraph` audits TWICE and BOTH sites derive
 *                   this label: the prompt gate on `data.prompt`, and the ACE Audio creative-field
 *                   audit on `musicDescription`/`lyrics`. So a submission carrying both contributes
 *                   2, an ordinary image submission 1, and one whose prompt is blank 0 — the gates
 *                   are enumerated in the `preset` note below. Divide with that in mind.
 * - `preset`      — surface `preset`: the SAME `generateFromGraph` code reached through
 *                   `submitPresetImageGen`. Split out for exactly the reason its sibling on the
 *                   submit metric is: a background job blended into `generate` would corrupt the one
 *                   division this metric supports.
 *                   🔴 THIS SERIES COUNTS CALLS, NOT SUBMISSIONS, AND NO CONSTANT CONVERTS ONE INTO
 *                   THE OTHER. `submitPresetImageGen` has THREE callers which contribute at
 *                   DIFFERENT rates, and nothing on the series distinguishes them:
 *                     · `orchestrator.router.ts`, the `iterateGenerate` procedure — interactive
 *                       tRPC, AT MOST 1 call per submission;
 *                     · `comics.router.ts`, via the `submitComicGeneration` helper that several of
 *                       that router's procedures share — interactive tRPC, AT MOST 1 call per
 *                       submission;
 *                     · `process-enqueued-comic-panels.ts` — the CRON JOB, AT MOST 2 calls per
 *                       panel: its explicit pre-submit `auditPromptServer` gate, which declares
 *                       `moderationSource: 'preset'` by hand, plus the one inside
 *                       `generateFromGraph`, which derives the same value from the surface.
 *                   🔴 EVERY NUMBER ABOVE IS A CEILING, NOT A RATE — which is the whole reason the
 *                   series cannot be divided back into submissions. Three things stand between a
 *                   submission and a classifier call, all of them ahead of `moderatePrompt`
 *                   (`promptAuditing.ts:295`): `auditPromptServer` returns early on an empty prompt
 *                   (`:244`), a HARD regex block throws (`:288`), and `generateFromGraph` audits
 *                   only when `data.prompt` is a non-blank string — which a preset submission need
 *                   not carry, since `buildPresetGraphInput` omits an empty prompt
 *                   (`preset-image-gen.service.ts:218`) and `iterateGenerate` hands it
 *                   `fullPrompt || undefined`. So an empty-prompt interactive submission contributes
 *                   0, and a cron panel contributes 0, 1 or 2.
 *                   ⚠️ NOT "a blocked panel contributes 0 or 1, never 2", which is what this comment
 *                   claimed a round ago. That holds only for a REGEX block. An external flag is
 *                   raised AFTER the classifier answers (`promptAuditing.ts:301`), so a panel the
 *                   second gate blocks has already paid both calls and contributes 2.
 *                   (The ACE Audio creative-field audit in `generateFromGraph` derives `preset`
 *                   too, but `buildPresetGraphInput` emits only txt2img/img2img input, so as of
 *                   today it contributes nothing here. A preset graph that ever carried
 *                   `musicDescription`/`lyrics` would add a fourth, again-different rate.)
 *                   🔴 THE TRADE THIS PR MADE, so nobody re-derives it as a bug: before it, the
 *                   cron's explicit gate declared nothing and fell to `other` — which inflated
 *                   `other` and undercounted the cron here, but held `preset` to no more than one
 *                   observation per preset submission. Labelling the gate `preset` fixed the `other`
 *                   inflation and cost `preset` that ceiling. Read it as a call rate on
 *                   preset work; to recover a per-panel figure you need a label that separates the
 *                   cron from the two interactive routes, which does not exist today.
 * - `remixAudit`  — the `audit-remix-sources` background job, which calls `moderatePrompt` directly
 *                   rather than through `auditPromptServer`. Batch work, no user waiting on it.
 * - `other`       — every other `auditPromptServer` caller (App Blocks host-side audits, prompt
 *                   enhancement, shared content-safety). The DEFAULT, so a caller that declares
 *                   nothing can never silently inflate `generate`.
 *
 * 🔴 `other` is a genuine mixture, not a residue worth attributing — do not read it as any single
 * path. It is deliberately NOT split further, but the PLUMBING IS NO LONGER THE REASON: this PR put
 * `moderationSource` on `AuditPromptOptions` and it already reaches all nine `auditPromptServer`
 * call sites, every one of which can declare a value today. What splitting a funnel out still costs
 * is vocabulary and a decision per site: a new member added BOTH to this union and to
 * `EXTERNAL_MODERATION_SOURCES` below (the clamp is a closed set — a union member missing from the
 * set falls silently to `other`), the literal written at the site being split, and that site's row
 * updated in `moderation-source-wiring.test.ts`. That is cheap per funnel and is why it is done one
 * funnel at a time, on evidence that the funnel is worth its own series — not because `other` is
 * hard to reach.
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
 * retains every distinct label set in the Node heap until the metric is reset, independently in
 * every scraped pod, so one stray string is a cardinality incident with a green suite and no error
 * anywhere.
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
 * 🔴 THE TOP END IS THE PART THAT IS LOAD-BEARING: the top finite boundary must sit ABOVE the
 * configured deadline. A family whose top finite bucket sat AT or below the cap would drop every
 * capped call into `+Inf` together with every pathological one, saturating exactly the region being
 * asked about — the boundary a bucket-based quantile cannot see past. `10` and `20` carry two
 * further things: the deadline is an env knob that can be re-tuned upward, so the tail keeps some
 * resolution if it is; and under the default cap a NON-EMPTY `+Inf` is itself a finding (nothing
 * should ever exceed the deadline by 15 s — that would mean the abort did not take effect), which a
 * bucket set stopping at the cap could not express. `external-moderation.metrics.test.ts` pins this.
 *
 * 🔴 NO BOUNDARY SEPARATES A CAPPED CALL FROM ONE THAT ANSWERED JUST UNDER THE CAP, AND NONE CAN.
 * This comment and the help text below used to claim the opposite — that a fired deadline is observed
 * at slightly MORE than 5 s and so lands in `le=7.5` while a sub-cap call lands in `le=5`, "adjacent
 * but separate". That is FALSE, and it was measurable:
 *   · `le` is INCLUSIVE, `AbortSignal.timeout()` fires off a libuv timer, and the recorded duration
 *     is a `performance.now()` delta. Those two clocks disagree by a small fixed offset, so the
 *     elapsed time measured when the deadline fires can land just BELOW the deadline. Measured on one
 *     host: 3/60 samples at a 100 ms deadline and 3/8 at a 5000 ms deadline came in EARLY, worst case
 *     0.63 ms — the same magnitude at both, i.e. a constant offset, not a clock-rate difference. The
 *     end-to-end test asserting "never in le=5" therefore failed ~20-25% of the time.
 *   · Perfect clocks would not rescue it either: a call that answered a microsecond under the cap and
 *     one cut BY the cap are arbitrarily close in duration, so no bucket edge can lie between them.
 *   · And the deadline is an env knob (`.min(100).max(60000)`), so NO FIXED BUCKET SET can guarantee
 *     any boundary relationship to it across deployments.
 * `outcome="timeout"` separates those two populations, deterministically, and always did: it is a
 * branch on the abort error (`isAbortDeadlineError`), not a race between two clocks. Classify by that
 * label. The bucket set's job is resolution, not classification.
 *
 * 🔴 WHY `4.5` AND NOT `5` — this set used to carry `5`, exactly the default deadline in seconds.
 * Given the above, a boundary sitting on the deadline buys nothing, and it costs something: it splits
 * the single `outcome="timeout"` mode across `le=5` and `le=7.5` on that same sub-millisecond coin
 * flip, so a dashboard renders one population as two. What `4.5` buys is 500 ms of clearance from
 * the DEFAULT cap — ~800x the measured 0.63 ms clock offset — so at the default nothing races it.
 *
 * ⚠️ That clearance is the whole argument, and an earlier version of this comment claimed more than
 * it: that `4.5` is "OFF-ROUND" and so "cannot coincide" with a configured deadline, because those
 * are round millisecond values. That is false twice over — 4.5 s IS 4500 ms, a perfectly round
 * millisecond value, and the next sentence already conceded a deployment can set it. There is no
 * roundness property here to lean on. This is a MITIGATION FOR THE DEFAULT DEPLOYMENT, NOT A
 * GUARANTEE FOR ANY: the deadline is an env knob over [100 ms, 60 s], and every boundary in the set
 * below from `0.1` to `20` inclusive falls inside that range — so a deployment can land its deadline
 * exactly on any of them, 4500 ms included. Wherever that happens, only `outcome` remains correct —
 * which is precisely why correctness rests on that label and not on this number. Only this one
 * boundary moved; the rest of the set is unchanged, because nothing else about it was wrong.
 */
const EXTERNAL_MODERATION_BUCKETS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4.5, 7.5, 10, 20,
] as const;

const durationHistogram = registerHistogram({
  name: 'external_moderation_duration_seconds',
  help:
    'Duration (seconds) of an external prompt-moderation call (extModeration.moderatePrompt) as the ' +
    'CALLER experiences it: the whole outbound classifier request, including body parse. Labeled by ' +
    'source (generate|preset|remixAudit|other) + outcome (ok|error|timeout). The call sits inline and ' +
    'serially on the generation submission path and is FAIL-SOFT, so a rising error rate here is ' +
    'invisible to every user-facing signal — it means prompts are being generated with only the local ' +
    'regex gate applied. outcome=timeout is the EXTERNAL_MODERATION_TIMEOUT_MS deadline firing, ' +
    'branched off the abort error rather than off the duration: IDENTIFY CAPPED CALLS BY THAT LABEL, ' +
    'never by which bucket they land in — a capped call and one that answered a hair under the cap are ' +
    'arbitrarily close in duration, so no bucket edge separates them. Filter on source ' +
    'before attributing a figure to a procedure: source=generate is the orchestrator.generateFromGraph ' +
    'audits (the prompt gate AND the ACE Audio creative fields) for EVERY surface except preset — ' +
    'onsite, api AND block (App Blocks), so it is not on-site-only — while remixAudit is batch work ' +
    'with nobody waiting. Every series counts CALLS, not submissions: one submission can audit ' +
    'twice, and a blocked or blank-prompt one may never reach the classifier at all.',
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
