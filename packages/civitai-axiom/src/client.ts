import { Client } from '@axiomhq/axiom-node';
import { loadAxiomEnv, type AxiomConfig } from './env';

// Package-local alias (not a `declare global`) so a consumer transpiling this package doesn't need the main
// app's ambient MixedObject global in scope. Same shape, so main-app callers are unaffected.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MixedObject = Record<string, any>;

/**
 * Extract only safe primitive fields from an error for logging.
 *
 * Logging raw error objects (especially from axios or AWS SDK) blows up the
 * Axiom schema because each unique key in `.config`, `.headers`, `.cause`,
 * `.$metadata`, `.config.data._readableState`, etc. becomes a separate field.
 * Always pass errors through this helper before logging them.
 */
export function safeError(e: unknown): MixedObject | undefined {
  if (e == null) return undefined;
  if (e instanceof Error) {
    const anyErr = e as { code?: unknown; cause?: unknown; inner?: unknown };
    const cause = anyErr.cause;
    // `@node-oauth/oauth2-server` nests the underlying failure in `.inner` (NOT `.cause`) — its
    // `ServerError` wraps the real error, so the top-level name/message/stack are the generic library
    // frame. Capture the inner name/message + its stack (the real failing line) so wrapped auth 500s
    // stay triageable. Kept to primitives only, same as the rest of this helper.
    const inner = anyErr.inner;
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      code: anyErr.code,
      causeMessage:
        cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined,
      innerName: inner instanceof Error ? inner.name : undefined,
      innerMessage:
        inner instanceof Error ? inner.message : inner != null ? String(inner) : undefined,
      innerStack: inner instanceof Error ? inner.stack : undefined,
    };
  }
  return { message: String(e) };
}

export type AxiomLogger = {
  logToAxiom: (data: MixedObject, datastream?: string) => Promise<void>;
  safeError: typeof safeError;
};

/**
 * An additional sink for the structured line this logger already builds.
 *
 * `body` is the exact string written to stderr, so a sink that forwards it verbatim
 * stays byte-identical to the stderr path and a query written against one matches the
 * other. `data` is the same payload in object form, for sinks that need fields.
 *
 * INJECTED, not imported: this keeps `@civitai/axiom` free of any dependency on (and any
 * semantics of) whatever transport the app happens to bolt on. See ./env's header —
 * "App behavior (loggers, policy callbacks) would be injected at the factory instead".
 *
 * Must not throw; `logToAxiom` contains it anyway, because a telemetry sink must never
 * be able to fail the code path it is observing.
 */
export type EmitLog = (body: string, data: MixedObject, datastream?: string) => void;

export type AxiomDeps = {
  emitLog?: EmitLog;
};

/**
 * How long the Axiom dual-write may hold the CALLER before we stop waiting for it.
 *
 * 🔴 This is a CEILING ON THE CALLER, not a request timeout — nothing here cancels the
 * in-flight POST. The underlying SDK (`@axiomhq/axiom-node`) drives axios with its own
 * hardcoded `timeout: 30000`, which is not reachable through `new Client({token, orgId})`,
 * so 30 s is what a request against a black-holed endpoint actually costs. That number is
 * fine for a background flush and catastrophic on a request path: on 2026-08-23 Axiom's
 * ingest host became unreachable for 44 minutes and every awaited `logToAxiom` on
 * `/api/upload/{complete,abort,index}` stalled 30 s and then threw, turning uploads that
 * had ALREADY SUCCEEDED into 500s for 350 users. See the containment note at the
 * `ingestEvents` call below.
 *
 * 2 s is chosen to be longer than a healthy ingest (single-digit ms) by a wide margin and
 * short enough to be invisible next to the work these hot paths already did.
 */
const AXIOM_INGEST_TIMEOUT_MS = 2_000;

/**
 * Report every Nth consecutive dual-write failure, not every one.
 *
 * A multi-minute Axiom outage produces one failure per logged event — 6,444 of them in
 * 44 minutes during the incident above. One line each would be its own noise incident in
 * Loki; zero lines would make the outage invisible from inside the app. Report the FIRST
 * failure (so the start is timestamped), then every Nth (so the scale is legible), then the
 * recovery with the total.
 */
const AXIOM_INGEST_FAILURE_REPORT_EVERY = 500;

/**
 * Build an Axiom logger. Config defaults come from the package's own env schema
 * (./env); pass a `Partial<AxiomConfig>` to override any value per call (tests,
 * multi-instance, alternate config sources). `deps` injects optional app behavior —
 * default `{}`, so a consumer that passes nothing gets exactly the previous behavior.
 * See the `~/server/logging/client` shim.
 */
export function createAxiomLogger(
  overrides: Partial<AxiomConfig> = {},
  deps: AxiomDeps = {}
): AxiomLogger {
  const config = { ...loadAxiomEnv(), ...overrides };

  const axiom =
    config.token && config.orgId ? new Client({ token: config.token, orgId: config.orgId }) : null;

  // Consecutive-failure count for the Axiom dual-write. Per-logger, not global: a second
  // logger instance is a second transport and gets its own outage.
  let ingestFailures = 0;

  /**
   * Record the outcome of one dual-write and, on a transition or every Nth failure, say so
   * on the stderr/Loki path that is still working. `'timeout'` is counted as a failure: we
   * stopped waiting, so from the caller's side the event is not known to have landed.
   *
   * Deliberately NOT routed through `logToAxiom` itself — that would try to ship the report
   * of an Axiom outage to Axiom, and recurse.
   */
  function recordIngestOutcome(outcome: 'ok' | 'error' | 'timeout') {
    if (outcome === 'ok') {
      if (ingestFailures > 0) {
        console.error(
          JSON.stringify({ name: 'axiom-ingest-recovered', failedSince: ingestFailures })
        );
        ingestFailures = 0;
      }
      return;
    }
    ingestFailures += 1;
    if (ingestFailures === 1 || ingestFailures % AXIOM_INGEST_FAILURE_REPORT_EVERY === 0) {
      console.error(
        JSON.stringify({
          name: 'axiom-ingest-failed',
          reason: outcome,
          consecutiveFailures: ingestFailures,
        })
      );
    }
  }

  async function logToAxiom(data: MixedObject, datastream?: string) {
    const sendData = { pod: config.podName, ...data };
    if (config.isProd) {
      datastream ??= config.datastream;

      // Write stderr BEFORE the Axiom-null/datastream guards (and before awaiting
      // Axiom) — Loki ingest depends on this stderr line, so it must fire even when
      // no Axiom client is configured (preview envs use a placeholder token → axiom
      // is null) or when Axiom is degraded (ingestEvents rejects and the rest of this
      // function never runs). Without this ordering, preview tRPC 500s never reach
      // Loki, and the Grafana alerts that consume `{ "name": "sysredis-fail-open",
      // ... }` go silent during the exact multi-service incident class they exist to
      // handle (sysRedis + Axiom both down). `_axiom: datastream` may be undefined in
      // previews (no AXIOM_DATASTREAM) — JSON.stringify drops it; the line still
      // carries message/stack/code/path.
      //
      // ALWAYS-ON (Phase 1 of the Axiom→Loki migration): this structured line is the
      // durable, queryable sink — stdout/stderr → Alloy → Loki. It used to be gated
      // behind `LOG_ERRORS_TO_STDOUT==='true'` (a blunt per-deployment flag); the gate
      // is removed so every event lands in Loki by default while the Axiom dual-write
      // below continues during the transition. Volume/noise control belongs in the
      // Alloy pipeline (sample/drop + line-size cap), not an app-side gate.
      //
      // SERIALIZATION GUARD: this write is UNCONDITIONAL and logToAxiom is called (often
      // awaited) on hot paths (the central tRPC 500 handler, payment webhooks, uploads)
      // with arbitrary objects. JSON.stringify THROWS on BigInt / circular refs, so an
      // unguarded stringify could break a caller that previously never hit this line.
      // Contain it: a serialization failure must NEVER break the caller — emit a minimal,
      // stringify-safe fallback (itself wrapped) so the event isn't silently lost.
      //
      // ONE serialization, N sinks. The line is built once and then handed to every
      // sink, so the stderr text and any injected sink's body are the SAME string —
      // a query written against one path matches on the other — and a hot path that
      // may be awaited pays for one JSON.stringify rather than one per sink.
      let line: string;
      try {
        line = JSON.stringify({ _axiom: datastream, ...sendData });
      } catch (err) {
        try {
          line = JSON.stringify({
            _axiom: datastream,
            name: (sendData as MixedObject)?.name,
            _stringifyError: String(err),
          });
        } catch {
          // Triple fault (even the minimal payload won't serialize). Not JSON — the
          // consumers of this line all tolerate a non-JSON line, and anything that
          // tried to build JSON here would be the fourth thing to throw.
          line = `logToAxiom: failed to serialize event ${String((sendData as MixedObject)?.name)}`;
        }
      }

      console.error(line);

      // Additional sink, if one was injected. Deliberately AFTER the stderr write and
      // contained: an injected sink is app-supplied code, and neither its cost nor its
      // failure may reach the stderr write above, the Axiom dual-write below, or the
      // caller. A sink that throws is swallowed here; counting it is the sink's job.
      if (deps.emitLog) {
        try {
          deps.emitLog(line, sendData, datastream);
        } catch {
          /* contained — see above */
        }
      }

      if (!axiom) return;
      if (!datastream) return;

      /**
       * 🔴 CONTAINED AND BOUNDED — the same contract the injected sink above already has,
       * and for the same reason stated there: a telemetry sink must never be able to fail
       * the code path it is observing. Until 2026-08-23 this one line was the sole
       * uncontained sink in this function, and the exception proved expensive.
       *
       * WHAT IT COST. Axiom's ingest host went unreachable 01:08–01:52Z on 2026-08-23.
       * `logToAxiom` is awaited on hot paths (this file's own header says so), so the
       * rejection propagated into the callers:
       *   - `/api/upload/complete` — the multipart completion had ALREADY SUCCEEDED; the
       *     throw happened on the log line after it, so a stored object was reported to the
       *     browser as a 500. ~5,300 failed requests, 350 distinct users, 44 minutes.
       *   - the same handlers' CATCH blocks awaited this before classifying the error, so
       *     the 409/422/503 taxonomy was structurally unreachable and every fault — 1,009
       *     of them a terminal `NoSuchUpload` — went out as a retryable 500. Clients
       *     retried; the retries re-failed. (The handlers have since been reordered too;
       *     this containment is the half that does not depend on remembering to.)
       *   - the background `jobs` pods call it WITHOUT awaiting, so there the rejection was
       *     an `unhandledRejection` and Node exited. All three pods died at 01:06:45Z.
       *
       * WHY A RACE AND NOT JUST A TRY/CATCH. try/catch alone fixes the throw but not the
       * 30 s stall (see AXIOM_INGEST_TIMEOUT_MS) — the caller would still be held for 30 s
       * per logged event against a black-holed endpoint, which on the upload path is
       * indistinguishable from an outage. Nothing here cancels the request; we stop
       * WAITING for it.
       *
       * 🔴 The rejection handler is attached in the same `.then(onOk, onErr)` as the success
       * handler — NOT as a later `.catch()` and not inside the race. When the budget wins,
       * this promise is left running with nobody awaiting it; an unhandled rejection at
       * that point is precisely the `unhandledRejection` that killed the jobs pods, i.e.
       * the bug re-created by the fix for it.
       */
      const ingest = axiom.ingestEvents(datastream, sendData).then(
        () => 'ok' as const,
        () => 'error' as const
      );

      let onBudgetExpired!: (outcome: 'timeout') => void;
      const budget = new Promise<'timeout'>((resolve) => {
        onBudgetExpired = resolve;
      });
      const timer = setTimeout(() => onBudgetExpired('timeout'), AXIOM_INGEST_TIMEOUT_MS);
      // Never let a pending telemetry budget hold a process open at shutdown.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }

      try {
        recordIngestOutcome(await Promise.race([ingest, budget]));
      } finally {
        clearTimeout(timer);
      }
    } else {
      console.log('logToAxiom', sendData);
    }
  }

  return { logToAxiom, safeError };
}
