// Package-owned env schema. Any app that uses @civitai/axiom validates these
// vars the same way, so every app logs to Axiom with identical config.
import * as z from 'zod';

/**
 * 🔴 THIS CONTENT LIVES IN env.ts DELIBERATELY — DO NOT SPLIT IT BACK OUT INTO ITS OWN MODULE.
 *
 * It was its own file (`./datastreams`) for one commit, and that broke a build guard:
 * `src/server/services/__tests__/no-server-infra-in-app-graph.test.ts` walks the module graph
 * reachable from the app's `_app.tsx` and denies everything under `packages/civitai-axiom/`. This
 * module is ALREADY on that graph and already carries a reviewed exception; a NEW module imported
 * from here is a NEW node on that chain, and the guard failed exactly as designed.
 *
 * A dynamic `import()` does not dodge it — the chunk is still compiled into the client bundle. And
 * the guard's own doctrine is that its allowlist "can shrink but never silently grow", so adding an
 * entry for a violation this change introduced would have been the wrong repair. Keeping the values
 * here adds ZERO nodes to the client graph.
 *
 * (These are pure constants with no imports, so a defensible alternative was to narrow the
 * denylist the way `@civitai/buzz` already is — carving the pricing constants out from the service
 * transport. That edits a shared safety mechanism to accommodate this change, so it is recorded as
 * a follow-up on the PR rather than done here.)
 */

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
 * That failure mode shipped and ran unnoticed. Measured against the ingest org, TEN distinct
 * datastream names in this repo had no dataset behind them, across 18 production call sites; the
 * oldest had been failing 100% of its writes for ~76 days. No telemetry was actually lost — `logToAxiom` writes the full structured line
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

const booleanString = z.preprocess((val) => val === true || val === 'true', z.boolean());

// Every env var the Axiom logger reads is declared here so it's validated on
// deployment. App *behavior* (loggers, policy callbacks) would be injected at the
// factory instead — but those are functions, not env values, and this package has none.
const schema = z.object({
  AXIOM_TOKEN: z.string().optional(),
  AXIOM_ORG_ID: z.string().optional(),
  AXIOM_DATASTREAM: z.string().optional(),
  // Comma-separated. WIDENS the provisioned-dataset allowlist below so a dataset created
  // in the Axiom console can be adopted by configuration, without waiting on a code release. It can
  // only add names, never remove them — see buildProvisionedDatastreams.
  AXIOM_EXTRA_DATASTREAMS: z.string().optional(),
  PODNAME: z.string().optional(),
  LOG_ERRORS_TO_STDOUT: booleanString.default(false),
});

// Normalized, env-derived defaults. The factory accepts a Partial<AxiomConfig> to
// override any of these per call (tests, multi-instance, alternate config sources).
function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/axiom] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return {
    token: parsed.data.AXIOM_TOKEN,
    orgId: parsed.data.AXIOM_ORG_ID,
    datastream: parsed.data.AXIOM_DATASTREAM,
    // The set of dataset names the Axiom dual-write is allowed to target. Resolved here (not read
    // from the module const at the call site) so a test or an alternate config source can override
    // it through the factory's Partial<AxiomConfig>, exactly like every other value on this object.
    provisionedDatastreams: buildProvisionedDatastreams(
      parseExtraDatastreams(parsed.data.AXIOM_EXTRA_DATASTREAMS)
    ),
    podName: parsed.data.PODNAME,
    logErrorsToStdout: parsed.data.LOG_ERRORS_TO_STDOUT,
    // NODE_ENV is a universal Node convention (not Next-specific), so it's fine for a package.
    isProd: process.env.NODE_ENV === 'production',
  };
}

export type AxiomConfig = ReturnType<typeof buildEnv>;

// Lazy + memoized: importing this module does NOT touch process.env. Validation runs
// only when the factory calls loadAxiomEnv() — so a bare import (build, script, test)
// never throws. Parsed once, then cached.
let _env: AxiomConfig | undefined;
export function loadAxiomEnv(): AxiomConfig {
  return (_env ??= buildEnv());
}
