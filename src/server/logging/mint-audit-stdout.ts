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
 * That matters because these events are the primary signal for the step-3 adoption
 * gate of #3703 (issue #3715): the gate flips a spend default only after
 * `spendGrantBasis === 'inferred'` falls to zero over a rolling window. Read from a
 * surface that structurally cannot see the event, a clean zero is meaningless — and
 * indistinguishable from real adoption.
 *
 * So this is a DUAL SINK, not a duplicate log. Axiom keeps the rich, queryable copy;
 * stdout is the copy the log store can actually see. Removing either half re-opens the
 * blind spot. Do not "simplify" this away.
 *
 * 🔴 Callers pass FLAGS AND IDENTIFIERS ONLY — never a token, a secret, or PII.
 */

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
export function emitMintAuditToStdout(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...fields }));
}
