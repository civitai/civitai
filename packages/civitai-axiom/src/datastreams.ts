/**
 * The Axiom datasets that ACTUALLY EXIST in the org this app ingests to.
 *
 * 🔴 WHY THIS LIST EXISTS AT ALL. `logToAxiom(data, datastream)` names its target dataset as a
 * plain string. Axiom does NOT auto-create a dataset on ingest with our token, so a name that was
 * never provisioned in the Axiom console is rejected on every write, forever, from every process —
 * and nothing in the call site, the type system or the test suite can tell you that. The rejection
 * surfaces only as `{"name":"axiom-ingest-failed","reason":"error"}`, a CATEGORY that a 404, a 503
 * and an ECONNRESET all share, so it reads as transient.
 *
 * That failure mode shipped and ran unnoticed. Measured against the ingest org, ELEVEN distinct
 * datastream names in this repo had no dataset behind them; the oldest had been failing 100% of its
 * writes for ~76 days. No telemetry was actually lost — `logToAxiom` writes the full structured line
 * to stderr (→ the log store) BEFORE it attempts the Axiom write, unconditionally, and every real
 * consumer of these events reads the log store or metrics, never Axiom. What was lost was a longer
 * retention window, and 76 days of a permanently-red write path nobody could see.
 *
 * So: this set is the CHECKABLE form of a claim the code was previously only implying. A datastream
 * that is not in it does not reach `ingestEvents` at all — the event stays on the stderr/log-store
 * path, which is where the platform's logging is migrating anyway. See the guard in ./client.
 *
 * ---
 *
 * HOW THIS LIST WAS DERIVED, AND HOW TO REFRESH IT. It is the complete response of
 * `GET https://api.axiom.co/v1/datasets` for the ingest org, measured 2026-08-24. Each name was
 * additionally confirmed individually via `GET /v1/datasets/<name>` → 200, against a negative
 * control (`zz-control-not-a-dataset` → 404) proving a 404 means "absent" rather than
 * "unauthorized". Re-measure the same way rather than editing this list from memory.
 *
 * 🔴 IT IS A SNAPSHOT, AND THAT IS THE ONE WAY IT CAN BITE. Creating a dataset in the Axiom console
 * does NOT add it here, so writes to a genuinely-new dataset are skipped until this list is updated.
 * The escape hatch for that is `AXIOM_EXTRA_DATASTREAMS` (see ./env) — a comma-separated env var
 * that ADDS to this set, so a newly-provisioned dataset can be adopted by configuration without
 * waiting on a code release. It can only widen the set, never narrow it, so a typo there cannot
 * silence a stream that currently works.
 *
 * Every deployment's configured default (`AXIOM_DATASTREAM`) was checked against this set at the
 * time of writing — `civitai-prod`, `civitai-next`, `civitai-stage-new`, `civitai-advertising` and
 * `notifications` are all members — so the guard changes nothing about default-routed events.
 */
export const PROVISIONED_AXIOM_DATASTREAMS: ReadonlySet<string> = new Set([
  'axiom-audit',
  'civitai-advertising',
  'civitai-event-watcher',
  'civitai-next',
  'civitai-prod',
  'civitai-stage-new',
  'clickhouse',
  'kafka-orchestration-monitor',
  'notifications',
  'orchestration-otlp',
  'python-worker',
  'temp-search',
  'webhooks',
]);

/**
 * Parse the `AXIOM_EXTRA_DATASTREAMS` env value into names.
 *
 * Lenient on separators/whitespace and drops empties, because the cost of a strict parse here is an
 * env var that silently does nothing. Exported so the env schema and its test agree on one
 * implementation rather than two spellings of "split on comma".
 */
export function parseExtraDatastreams(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The effective allowlist: the provisioned snapshot, widened by any env-supplied extras.
 *
 * Widen-only by construction — `extra` is spread on top of the full snapshot, so no value of
 * `AXIOM_EXTRA_DATASTREAMS` can remove a name from the set.
 */
export function buildProvisionedDatastreams(extra: readonly string[] = []): ReadonlySet<string> {
  return new Set([...PROVISIONED_AXIOM_DATASTREAMS, ...extra]);
}
