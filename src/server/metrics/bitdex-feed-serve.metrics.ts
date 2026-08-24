// BitDex feed SERVE-OUTCOME counters (issue #3930).
//
// The image feed can be answered by two different backends. When the primary
// backend is selected for a request it either serves the page or the request
// falls through to the search-index path — and until this module existed those
// two were indistinguishable from outside the process. Every reason the primary
// path declines collapses into a single `null` return: an unset config value, a
// non-2xx response, a thrown fetch, an abort at the timeout, a body that failed
// to parse, a 200 carrying zero documents, and a page the post-filter emptied
// all produce exactly the same observable. So "the feed is degraded" and "the
// index legitimately has nothing for this query" read identically, and neither
// can be alerted on.
//
// 🔴 NAMESPACE NOTE, and it matters for whoever reads this in a query editor:
// `bitdex_*` is ALSO the metric namespace of the backend service itself, which
// exports its own `bitdex_…` families from its own process. This family is
// APP-EMITTED — it is produced by the web application, on the request path, and
// describes what the APPLICATION did with the backend's answer. The two are
// scraped from different targets and are not comparable series. The `help`
// strings below say so as well, because a help string is the only thing that
// travels with the metric into a dashboard.
//
// TWO counters, because they answer questions with different owners:
//
//   `bitdex_primary_result_total{outcome, mode}` — per REQUEST, emitted from the
//   feed service. This is the served/fallback ratio: the number a decision about
//   rolling the primary path forward or back is actually made on.
//
//   `bitdex_query_failures_total{reason}` — per CALL, emitted from inside the
//   client. This is the "why", and it is unavailable from any other source: the
//   backend's own request metric carries no status-code label, so a 4xx caused
//   by shipping a filter on a field the index does not know is invisible
//   everywhere else. One request makes 1–4 calls, so these two counters have
//   DIFFERENT denominators and must not be divided by each other.
//
// 🔴 WHAT ONE `bitdex_primary_result_total` INCREMENT MEANS: one request that
// issued at least one query against the primary backend. It is NOT one page
// shown to a user (shadow-mode requests never reach a user), and it is NOT every
// request that had the primary path selected: the moderator queues the feed
// service declines BEFORE issuing any query (the scheduled / not-published
// queues, which the primary backend answers a different question for) are
// deliberately OUTSIDE this denominator. That decline is a policy choice, not a
// failure, and counting it as one would make the served ratio sag whenever a
// moderator opened a queue. The consequence to hold onto: `sum(…)` here is the
// count of requests that ENGAGED the backend, not the count of feed requests.
//
// The same exclusion covers other ways a request can reach the empty-result
// guard without contacting the backend. `fetchBitdexPrimary` gates on evidence
// that a call actually happened (see `bitdexCallsObserved` there), which covers
// a `limit` that collapses the fetch loop before its first iteration, and the
// query builder's five early returns — `hidden` with no signed-in user, `hidden`
// with no hidden images, an unresolvable username, followed-with-zero-follows,
// newCreators-with-none.
//
// ⚠️ BUT ONLY WHEN NO SECOND QUERY GOES OUT — AND THAT IS A PREDICATE, NOT A
// DESCRIPTION. Two successive hand-written glosses of it were each refuted by
// measurement ("all five doors are excluded"; "an anonymous caller or any
// paginated request"), so do not paraphrase it a third time. The condition is
// `skipOwnExcluded` in `fetchBitdexPrimary` (image.service.ts, declared beside
// the own-content pass), whose three disjuncts are exactly:
//   1. anonymous caller (`!input.currentUserId`)
//   2. a `bdx:` cursor — i.e. a BITDEX-paginated request, which is NOT the same
//      as any paginated request: a request that fell back to Meilisearch carries
//      a Meilisearch cursor on its next page and does NOT match
//   3. `creatorScopeExcludesCaller` — the request is scoped to a set of creators
//      that does not contain the caller. Named BY SYMBOL deliberately: it is
//      computed from three scopes (`userId`, `followed`, `newCreators`) and any
//      gloss of it drifts. This disjunct REPLACED "signed-in caller viewing
//      another user's profile" in #4123; that wording described only the
//      single-`userId` case and was silent on the set-shaped ones.
// When none holds, the own-content query goes out regardless of what the feed
// query did, so the request made a call and IS counted even though its feed
// query never left the process.
//
// 🔴 #4123 CHANGED WHICH DOORS THIS COUNTS, so the enumeration above it is no
// longer uniform. `followed`-with-zero-follows and `newCreators`-with-none are
// now excluded (their creator scope is the empty set, which does not contain the
// caller, so no second query goes out); `hidden`-with-no-hidden-images is still
// counted, because `hidden` is not a creator scope. That is a REDUCTION in the
// `fallback_empty` population and it SHIFTS THE SERVED-RATIO BASELINE, exactly as
// #4122 did — do not compare that ratio across #4123.
//
// Counting it is correct under "requests that ENGAGED the backend". It is simply
// not the same set as "requests whose FEED query went out", and a dashboard must
// not read it as the latter.
//
// The hand-driven internal comparison endpoint is outside the denominator too,
// by passing no callback: its calls reach `bitdex_query_failures_total` but
// never this counter.
//
// ⚠️ SCOPE OF THAT GUARANTEE, stated precisely because it is an invariant now.
// It covers `served`, `fallback_empty` and `fallback_error` — the three outcomes
// emitted from inside `fetchBitdexPrimary`, where the evidence lives.
// `fallback_exception` is emitted from the CALLER's catch arms and is
// deliberately NOT gated: it means "the application threw on the BitDex path",
// and whether a query had been issued first is irrelevant to that meaning — an
// app-side throw before the first call is still an app-side throw worth paging
// on, and suppressing it would blind the tripwire in the case where the code
// broke earliest. So `fallback_exception` has a deliberately different
// denominator from its three siblings. It reads a flat zero today.
//
// 🔴 THIS COUNTER ALONE CANNOT SEE EVERY DEGRADATION, AND AN ALERT BUILT ON IT
// ALONE WILL BE GREEN THROUGH ONE OF THEM. A request whose own-content pass
// fails while the main pass stays healthy still SERVES A PAGE — so it is
// recorded, correctly, as `served` — but the user has silently lost their own
// private/blocked/unpublished content from that page. The served ratio reads
// 100% throughout; only `bitdex_query_failures_total` moves. Demoting such a
// request was considered and rejected: it would make `served` mean "served and
// perfect", which no threshold can interpret. ⇒ ANY dashboard or alert over this
// family MUST read BOTH counters.
//
// `mode` is free signal rather than a second metric. The same code path runs in
// shadow, where the outcome previews what selecting the primary path for that
// cohort would have done — a shadow-blind counter can only measure an exposure
// after it has been taken. Folding the two into one series instead would make an
// alert threshold mean two different things depending on which cohort was
// flipped: a number that changes meaning without changing its name.
//
// 🔴 `fallback_exception` earns its own value rather than folding into
// `fallback_error`, because the two demand OPPOSITE responses. `fallback_error`
// means the backend or the network under it is unhealthy. `fallback_exception`
// means the application's own mapping/merge/sort code threw — page the app team,
// not the backend team. It reads a flat zero today, which makes it a clean
// tripwire rather than a redundant series.
//
// 🔴 CARDINALITY: 4 outcomes × 2 modes = 8 series, plus 6 failure reasons = 14
// series per process, TOTAL, and the bound rests on CODE — every label value is
// narrowed at runtime against a closed union declared once in this file, and an
// unrecognised value is DROPPED rather than passed through or relabelled to a
// plausible default (either would make the "14 series" claim a wish). Explicitly
// disqualified as labels: user id, cursor, filter shape, sort, model/post ids,
// and the raw status code — this fires once per feed request on the highest-
// traffic path in the application, nothing caches it, and prom-client retains
// every distinct label set in the Node heap for the life of the process. A
// `sort` label was considered and rejected for v1 (×5 → 40 series; the same
// question is answerable from the existing comparison metrics).
//
// prom-client GOTCHA (same as ~/server/metrics/generation-model-substitution.metrics.ts):
// Next.js can import a module twice (hot reload / route bundling) and prom-client
// throws if a metric name is registered twice, so the getters below are
// get-or-create guards against the DEFAULT global registry.
import client, { type Counter, type Registry } from 'prom-client';

/**
 * Per-REQUEST outcome of the primary feed path.
 *
 * - `served`      — the primary backend answered and its documents were returned.
 * - `fallback_empty` — every query in the request succeeded and the merged,
 *   post-filtered result was still empty. The index genuinely had nothing (or
 *   the post-filter removed everything). NOT a defect.
 * - `fallback_error` — the result was empty AND at least one query in the
 *   request failed. The empty result is UNTRUSTWORTHY: an own-content pass that
 *   failed while the main pass came back empty means you do not know whether the
 *   page was empty. This is the value this issue exists to make observable.
 * - `fallback_exception` — the application's own code threw while handling the
 *   response. Distinct owner, distinct response.
 *
 * The two below are empty CURSORED pages, which since 2026-08-24 do not fall
 * back at all. They are named apart from the `fallback_*` family on purpose: a
 * `bdx:` cursor is unreadable by the fallback backend, so routing one there
 * restarts the user's scroll at page 1. Counting these as `fallback_*` would
 * leave those counters describing a fallback that no longer happens — the same
 * drift as a counter whose meaning changes while its name does not.
 *
 * - `cursored_end` — an empty cursored page where every query succeeded. The
 *   feed was ended honestly. Routine, and the paginated twin of `fallback_empty`.
 * - `cursored_error` — an empty cursored page where at least one query failed,
 *   raised to the client as a retryable 503. The paginated twin of
 *   `fallback_error`, and the one worth alerting on.
 */
export const BITDEX_SERVE_OUTCOMES = [
  'served',
  'fallback_empty',
  'fallback_error',
  'fallback_exception',
  'cursored_end',
  'cursored_error',
] as const;
export type BitdexServeOutcome = (typeof BITDEX_SERVE_OUTCOMES)[number];

/**
 * Which cohort the request ran in.
 *
 * - `primary` — the primary backend's answer was served to the user (or its
 *   failure sent the request to the fallback backend).
 * - `shadow`  — the same path ran in the background for comparison; the fallback
 *   backend served the user regardless of the outcome recorded here.
 */
export const BITDEX_SERVE_MODES = ['primary', 'shadow'] as const;
export type BitdexServeMode = (typeof BITDEX_SERVE_MODES)[number];

/**
 * Per-CALL failure classification, assigned at the client boundary where the
 * status code and the error object are still in scope. Once the call returns,
 * every one of these is the same `null`.
 *
 * - `unconfigured` — no endpoint configured; the call never left the process.
 * - `http_4xx` — the request was rejected. The tail-risk case: a filter on a
 *   field the index does not know is a 400, and it looks exactly like an empty
 *   index from every other vantage point.
 * - `http_5xx` — the backend failed to answer.
 * - `timeout` — the request was aborted at the client deadline.
 * - `network` — the fetch itself threw (DNS, connection refused, reset).
 * - `parse` — a 2xx whose body could not be decoded.
 */
export const BITDEX_QUERY_FAILURE_REASONS = [
  'unconfigured',
  'http_4xx',
  'http_5xx',
  'timeout',
  'network',
  'parse',
] as const;
export type BitdexQueryFailureReason = (typeof BITDEX_QUERY_FAILURE_REASONS)[number];

export function isBitdexServeOutcome(value: unknown): value is BitdexServeOutcome {
  return BITDEX_SERVE_OUTCOMES.includes(value as BitdexServeOutcome);
}

export function isBitdexServeMode(value: unknown): value is BitdexServeMode {
  return BITDEX_SERVE_MODES.includes(value as BitdexServeMode);
}

export function isBitdexQueryFailureReason(value: unknown): value is BitdexQueryFailureReason {
  return BITDEX_QUERY_FAILURE_REASONS.includes(value as BitdexQueryFailureReason);
}

type MetricsBundle = {
  primaryResultTotal: Counter<string>;
  queryFailuresTotal: Counter<string>;
};

/**
 * Initialise all 14 series to 0 at registration.
 *
 * 🔴 WHY, AND WHY IT IS NOT COSMETIC. prom-client only materialises a child
 * series on its first `inc()`, so without this a process exposes NOTHING for a
 * label combination until that combination occurs on that process. A read of
 * `…{outcome="fallback_error"}` then returns `no data`, which is
 * indistinguishable from "the instrument is not wired" — on the exact series
 * this issue exists to create, whose whole job is to be believed when it reads
 * zero.
 *
 * That is not hypothetical here. The older `bitdex_shadow_*` counters in
 * `~/server/bitdex/compare.ts` use the bare-registration pattern with no
 * seeding, and the consequence is live: they are present in the metric-name
 * index with history, and a current read of them returns `no data`. A real zero
 * and an absent series must be distinguishable, and today for those they are
 * not.
 *
 * Free by construction: 14 series is this family's whole cardinality budget, so
 * seeding costs exactly what a fully-exercised process already costs and cannot
 * grow.
 *
 * 🔴 SEEDING ALONE IS INERT. `ensureRegisterBitdexFeedServeMetrics` has no
 * caller outside this module, and the only production paths in are the two
 * `record…` functions below — which by definition run only once the event has
 * already happened. The missing half is the side-effect call in
 * `src/pages/api/metrics.ts` (which already documents this for the substitution
 * counter two imports above it). Both halves are required; neither works alone.
 *
 * Idempotent — `getOrCreateCounter` returns the EXISTING counter on re-entry and
 * `inc(…, 0)` is a no-op on an already-materialised series, so calling this on
 * every request cannot reset or double-count anything.
 */
function seedAllSeries(bundle: MetricsBundle): void {
  for (const outcome of BITDEX_SERVE_OUTCOMES) {
    for (const mode of BITDEX_SERVE_MODES) bundle.primaryResultTotal.inc({ outcome, mode }, 0);
  }
  for (const reason of BITDEX_QUERY_FAILURE_REASONS) bundle.queryFailuresTotal.inc({ reason }, 0);
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

/**
 * Idempotent: safe to call on every request. Returns the counter instances
 * (existing or newly created) from the default registry that /api/metrics
 * scrapes.
 */
export function ensureRegisterBitdexFeedServeMetrics(
  reg: Registry = client.register
): MetricsBundle {
  const primaryResultTotal = getOrCreateCounter(
    reg,
    'bitdex_primary_result_total',
    'APP-EMITTED (the web application, not the BitDex service, which exports its own bitdex_* families from a different scrape target). ' +
      'Feed requests that issued at least one query against BitDex, by what the application then did with the answer. ' +
      'One increment = one request, NOT one page shown to a user (shadow requests reach nobody) and NOT every request routed to the primary path: the moderator queues declined before any query is issued are deliberately outside this denominator. ' +
      'Deliberate exceptions to that denominator include: outcome=fallback_exception, which is emitted from the caller catch arms and is NOT gated on a query having been issued (it means the application threw on this path, which is worth paging on even if it threw before the first call); and a deployment with no endpoint configured, which reports a failure without a request leaving the process and so records fallback_error rather than going quiet. ' +
      'Also note a request whose FEED query returned early can still be counted, because the parallel own-content query may have gone out regardless (the condition is the skipOwnExcluded predicate in the feed service, not a property of the feed query). So this is "requests that engaged the backend", NOT "requests whose feed query went out", and must not be read as the latter. ' +
      'outcome (served = BitDex answered and its documents were returned; fallback_empty = every query succeeded and the merged post-filtered result was still empty, so the index genuinely had nothing — not a defect; fallback_error = the result was empty AND at least one query in the request failed, so the emptiness is untrustworthy; fallback_exception = the application code itself threw while handling the response — page the app team, not the backend team). ' +
      'mode (primary = BitDex served the user or its failure sent the request to Meilisearch; shadow = the same path ran in the background for comparison and Meilisearch served the user regardless).',
    ['outcome', 'mode']
  );

  const queryFailuresTotal = getOrCreateCounter(
    reg,
    'bitdex_query_failures_total',
    'APP-EMITTED (the web application, not the BitDex service). Individual BitDex query CALLS that failed, classified at the client boundary where the status code and error object are still in scope — after the call returns they are all the same null. ' +
      'One increment = one CALL, and one feed request makes 1-4 calls, so this counter has a DIFFERENT denominator from bitdex_primary_result_total and the two must not be divided by each other. ' +
      'reason (unconfigured = no endpoint configured, the call never left the process; http_4xx = the request was rejected, e.g. a filter naming a field the index does not know — invisible from every other vantage point because the service-side request metric carries no status-code label; http_5xx = the backend failed to answer; timeout = aborted at the client deadline; network = the fetch threw; parse = a 2xx whose body could not be decoded).',
    ['reason']
  );

  const bundle = { primaryResultTotal, queryFailuresTotal };
  seedAllSeries(bundle);
  return bundle;
}

/**
 * Fail-soft emit of one request-level serve outcome.
 *
 * 🔴 TOTAL, like every emitter in the sibling metrics modules. This instruments
 * the highest-traffic feed path in the application: a metrics error (registry
 * collision, label mismatch) must never propagate, or observing a successful
 * fallback would turn it into a failed feed request — the observability
 * converting a working request into an outage.
 */
export function recordBitdexPrimaryResult(
  outcome: BitdexServeOutcome,
  mode: BitdexServeMode
): void {
  try {
    // 🔴 The cardinality bound rests HERE, on code, not on the erased types
    // above. An unknown outcome or mode is DROPPED, not passed through and not
    // relabelled to a plausible default. Reachable today only by defeating the
    // types.
    if (!isBitdexServeOutcome(outcome) || !isBitdexServeMode(mode)) return;
    const { primaryResultTotal } = ensureRegisterBitdexFeedServeMetrics();
    primaryResultTotal.inc({ outcome, mode });
  } catch {
    /* instrument-only — never let a metrics error touch the feed path */
  }
}

/**
 * Fail-soft emit of one failed BitDex query call. Called from the client, which
 * is the only place the failure is still classifiable.
 */
export function recordBitdexQueryFailure(reason: BitdexQueryFailureReason): void {
  try {
    if (!isBitdexQueryFailureReason(reason)) return;
    const { queryFailuresTotal } = ensureRegisterBitdexFeedServeMetrics();
    queryFailuresTotal.inc({ reason });
  } catch {
    /* instrument-only — never let a metrics error touch the feed path */
  }
}
