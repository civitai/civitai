/**
 * STDOUT MIRROR for the App Blocks mint-audit events.
 *
 * WHY THIS EXISTS — the `req.log?.info(...)` sink these events already use writes
 * NOTHING to stdout in production, so the events are invisible to any log store that
 * scrapes container stdout.
 *
 * `Logger.sendLogs()` in `node_modules/@civitai/next-axiom/dist/logger.js:198-202`
 * (v0.17.0) prints to the console ONLY when `config.isEnvVarsSet()` is false — an
 * explicit "fallback to printing to console ... to avoid network errors in development
 * environments". With `AXIOM_TOKEN` + `AXIOM_DATASET` set, as in production, that
 * branch is dead: the batch is POSTed to Axiom's HTTP ingest and nothing is written to
 * stdout. Confirmed empirically over the full retained log-store window — sibling
 * events emitted via `console.log(JSON.stringify(...))` returned rows, while all five
 * `req.log` mint-audit events returned zero, including one that provably fired at
 * least 15 times.
 *
 * So this is a DUAL SINK, not a duplicate log. Removing either half loses a distinct
 * capability. Do not "simplify" this away.
 *
 * 🔴 WHAT EACH SINK IS FOR — THE TWO HAVE DIFFERENT HORIZONS, AND CONFUSING THEM
 * REINSTALLS THE VERY DEFECT THIS MODULE REMOVES.
 *
 *   - STDOUT (this file) is a SHORT-WINDOW FORENSIC copy, horizon ~72h. It is the right
 *     tool at incident time — "what happened during the outage an hour ago" — and a
 *     second sink that does not depend on a single vendor being reachable.
 *
 *   - AXIOM (`req.log?.info`) is the LONG-WINDOW ANALYTICAL copy, retention ~96 days.
 *     🔴 THE 30-DAY #3715 ADOPTION GATE IS READ FROM AXIOM, using the APL queries and
 *     schema check recorded on that issue. NOT from the log store.
 *
 * The 72h figure is measured, not assumed: the log store's GLOBAL retention is 72h with
 * compaction-based enforcement, and there is NO per-stream retention override covering
 * this application's namespace (the only overrides are unrelated: two 24h ones and one
 * 720h kernel stream). Live probe: ~1.7M lines present at now−1h/−24h/−48h/−70h, and
 * ZERO at now−96h and now−8d.
 *
 * 🔴 So DO NOT answer a 30-day question from stdout. #3715's gate is
 * `spendGrantBasis === 'inferred'` over a ROLLING 30 DAYS, against a base rate of ~24
 * bearer mints per 30 days (~0.8/day). A 72h window holds ~2.4 mints in total and
 * `inferred` is a subset of those, so a "30-day" LogQL query over this surface returns a
 * hard 0 essentially unconditionally — a structurally guaranteed zero, which is exactly
 * the defect this module was written to remove, merely relocated from a 0-day horizon to
 * a 3-day one. Reading it and flipping the Buzz-spend default would be the original bug.
 *
 * (A per-stream 720h override is NOT an available fix and is not claimed as one: those
 * selectors match STREAM LABELS, not line content, and these lines share the app's
 * ordinary stdout stream. Giving them 720h would require relabeling from line content
 * across the log pipeline — new streams, cardinality risk. Unproven follow-up at best.)
 *
 * 🔴 NOT EVERY EVENT IS GATE-BEARING — a reader counting all five against the #3715 gate
 * gets the wrong denominator:
 *
 *   - GATE-BEARING (carry `requestBudgetedSpend` + `spendGrantBasis`): the three BEARER
 *     mints, `blocks.dev-token.{pending,local,approved}-mint`.
 *   - AUDIT-ONLY (carry `spendGranted` only): the two DEV-TUNNEL mints,
 *     `app-blocks.dev-tunnel.{mint,owned-nonapproved-mint}`. Correct per #3715 — the
 *     tunnel path has no per-mint request mechanism to record, so there is no basis to
 *     derive. They are the BUSIER path in practice, which is what makes the wrong
 *     denominator easy to reach for.
 *
 * QUERYING — the two sinks SPELL FIELDS DIFFERENTLY, so a query written for one returns
 * a confident zero against the other rather than an error:
 *
 *   - Axiom (APL): event name in `message`, fields as `['fields.<name>']`. Canonical
 *     queries live on #3715; use those for anything gate-related.
 *   - Log store (LogQL), event name in `event`, fields TOP-LEVEL, ~72h only:
 *
 *       {namespace="<app-namespace>"} |= "blocks.dev-token." | json
 *         | event =~ "blocks.dev-token..*-mint"
 *
 *     POSITIVE CONTROL before believing any zero from it: drop the `event` filter and
 *     confirm the `|= "app-blocks.dev-tunnel."` form returns rows for the tunnel path
 *     (the busier one). A zero on both is a query/horizon problem, not evidence.
 *
 * 🔴 Callers pass FLAGS AND IDENTIFIERS ONLY — never a token, a secret, or PII.
 */

/** A value JSON can represent directly, with no conversion and no failure mode. */
type JsonScalar = string | number | boolean | null;

/**
 * The payload an audit event may carry: flat, scalar-valued, optionally a scalar array.
 *
 * 🔴 THIS NARROWNESS IS THE NON-THROWING GUARANTEE — do NOT widen it back to
 * `Record<string, unknown>` for convenience. `JSON.stringify` has exactly two throwing
 * inputs, a **BigInt** and a **circular structure**, and this type makes both
 * unrepresentable: a BigInt is not a `JsonScalar`, and a cycle needs a nested object or
 * array reference, which `readonly JsonScalar[]` cannot hold. A nested object is
 * excluded for the same reason, which also rules out a throwing custom `toJSON`.
 *
 * So the emitter below cannot throw, and it achieves that WITHOUT a try/catch. That
 * distinction is the point: a `catch` would trade a crash for a silently missing audit
 * line — the exact blind spot this module exists to close — whereas an unrepresentable
 * value is a COMPILE error at the call site, where someone can still fix it. An audit
 * log must never be able to break the operation it audits, and must never quietly skip
 * a record either.
 *
 * `undefined` is permitted so a caller can OMIT a key (see the three-valued signal
 * below); `JSON.stringify` drops undefined-valued keys rather than emitting `null`.
 */
export type MintAuditFields = Record<string, JsonScalar | readonly JsonScalar[] | undefined>;

/**
 * Write one mint-audit event to stdout as a single JSON line: `{"event":…, …fields}`.
 *
 * Emits unconditionally — these are low-volume audit events (a handful per day), and
 * this matches the existing unconditional `app-blocks.dev-tunnel.stop` mirror in
 * `src/server/services/blocks/dev-tunnel.service.ts`.
 *
 * `fields` is spread verbatim. Nothing is normalised, defaulted, or coerced, which is
 * load-bearing for `requestBudgetedSpend`: the step-3 gate reads a THREE-valued signal
 * (`true` / `false` / key omitted), and an omitted key must stay omitted rather than
 * becoming an invented `false` or `null`. A caller that wants a key absent omits it
 * from `fields`; this function will not put it back.
 */
export function emitMintAuditToStdout(event: string, fields: MintAuditFields): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...fields }));
}
