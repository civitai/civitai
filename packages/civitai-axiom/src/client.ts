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
 * globalThis-pinned consecutive-failure counts, keyed by datastream.
 *
 * Pinned for the reason documented at the use site: the bundler emits this module many times
 * into one build, and a module-scope `const` is therefore N independent objects rather than
 * one. The consuming app solves the identical problem the identical way for its log sink; this
 * mirrors it so the counter cannot be defeated by duplication.
 *
 * A `Symbol.for` key rather than a plain property so two copies agree without colliding with
 * anything else on the global.
 */
const INGEST_FAILURES_KEY = Symbol.for('@civitai/axiom.ingestFailuresByDatastream');

function getSharedIngestFailureCounts(): Map<string, number> {
  const g = globalThis as typeof globalThis & { [INGEST_FAILURES_KEY]?: Map<string, number> };
  return (g[INGEST_FAILURES_KEY] ??= new Map<string, number>());
}

/**
 * Datastreams already reported as unprovisioned, so the report fires ONCE per name per process.
 *
 * globalThis-pinned for the same reason the failure counter above is, and it matters more here:
 * the bundler emits this module many times into one server build, so a module-scope `Set` would
 * let the same name be reported once per copy. One line per dead datastream per process is a
 * diagnosis; fourteen is noise that gets filtered and then ignored.
 */
const UNPROVISIONED_REPORTED_KEY = Symbol.for('@civitai/axiom.unprovisionedDatastreamsReported');

function getSharedUnprovisionedReported(): Set<string> {
  const g = globalThis as typeof globalThis & { [UNPROVISIONED_REPORTED_KEY]?: Set<string> };
  return (g[UNPROVISIONED_REPORTED_KEY] ??= new Set<string>());
}

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

  /**
   * Consecutive-failure count for the Axiom dual-write, SHARED across every emitted copy of
   * this module that targets the same datastream.
   *
   * 🔴 A plain `let` here would be per-module-copy, and that is not the same as per-logger.
   * The consuming app's `structured-log-sink` records — measured — that the bundler emits its
   * logging module **14 distinct times into one server build**; that duplication is exactly
   * what once made an OTel bridge deliver 1.3% of records. With 14 private counters, each sees
   * ~1/14th of the traffic: the "first failure" line fires up to 14 times and no copy need ever
   * reach the every-Nth threshold, so a 6,444-event outage could report as a handful of
   * `consecutiveFailures: 1` lines and nothing else. That is the throttle failing in the one
   * direction that matters.
   *
   * Keyed by datastream rather than globally, because two loggers pointing at DIFFERENT
   * datastreams really are different transports with independent outages — while N copies of
   * one module pointing at the SAME datastream are one transport that happens to be duplicated.
   */
  const ingestFailuresByDatastream = getSharedIngestFailureCounts();

  /**
   * Record the outcome of one dual-write and, on a transition or every Nth failure, say so
   * on the stderr/Loki path that is still working. `'timeout'` is counted as a failure: we
   * stopped waiting, so from the caller's side the event is not known to have landed.
   *
   * Deliberately NOT routed through `logToAxiom` itself — that would try to ship the report
   * of an Axiom outage to Axiom, and recurse.
   *
   * 🔴 `type: 'error'` is what makes this event findable. **Query it as `| type="error"`.**
   *
   * That much is measured: Alloy JSON-parses this stderr line and promotes `type` to structured
   * metadata, `| type="error"` returns rows, and the negative control `| type="zzz-none"`
   * returns none.
   *
   * ⚠️ DO NOT ADD A FOURTH THEORY ABOUT `detected_level` TO THIS COMMENT. Three successive
   * rewrites each asserted a different mechanism for it and each was refuted by the next
   * round's measurement — "`type` → `detected_level`", then "nothing reads `level`", then
   * "`detected_level` is derived from the `level` key". The last was refuted by the control
   * that version failed to run: lines carrying `"type":"error"` and NO `level` key resolve to
   * `detected_level="error"` **100% of the time**, so `level` is not NECESSARY for it (that is
   * what the data shows — not that nothing ever reads `level`, which stays unresolvable here);
   * and the discriminator that version cited could never have separated the two, because no
   * line in this namespace carries `level` without also carrying `type`. `| level=` matches nothing at
   * all — `level` has no structured-metadata surface here.
   *
   * So: `level` is emitted for SHAPE CONSISTENCY with the rest of the codebase's log records,
   * NOT because anything here is known to read it. It is harmless and cheap; it is not the
   * reason these lines are findable. If you need to know how `detected_level` is really
   * derived, measure it — do not trust this comment, and do not extend it with a guess.
   *
   * Figures are deliberately not quoted here: an undated hit count in a source comment is
   * unfalsifiable and decays. Re-measure against Loki with a negative control when it matters.
   *
   * `pod` is carried for parity with every other line this logger emits, so a reader who has
   * the line in hand can attribute it without joining. It is ALSO already a Loki stream label
   * from k8s service discovery, so this is redundancy rather than the only source.
   */
  function recordIngestOutcome(outcome: 'ok' | 'error' | 'timeout', datastream: string) {
    const failures = ingestFailuresByDatastream.get(datastream) ?? 0;
    if (outcome === 'ok') {
      if (failures > 0) {
        console.error(
          JSON.stringify({
            name: 'axiom-ingest-recovered',
            // Recovery is good news: INFO, so it does not page as an error itself.
            type: 'info',
            level: 'info',
            pod: config.podName,
            datastream,
            failedSince: failures,
          })
        );
        ingestFailuresByDatastream.set(datastream, 0);
      }
      return;
    }
    const next = failures + 1;
    ingestFailuresByDatastream.set(datastream, next);
    if (next === 1 || next % AXIOM_INGEST_FAILURE_REPORT_EVERY === 0) {
      console.error(
        JSON.stringify({
          name: 'axiom-ingest-failed',
          type: 'error',
          level: 'error',
          pod: config.podName,
          datastream,
          reason: outcome,
          consecutiveFailures: next,
        })
      );
    }
  }

  const unprovisionedReported = getSharedUnprovisionedReported();

  /**
   * Say ONCE, on the stderr/log-store path, that a datastream was skipped because no Axiom dataset
   * backs it.
   *
   * This is deliberately NOT `axiom-ingest-failed`. Nothing failed: the event is on the durable
   * stderr path, and we declined to attempt a write we know Axiom rejects. Emitting a failure here
   * would put a permanent, unrecoverable entry into the consecutive-failure counter that the
   * ingest-wedged alerting reads, and would re-create the exact signal-vs-noise problem this
   * change removes.
   *
   * It is still an `error`-typed line rather than a warning, because a datastream name in the
   * source with no dataset behind it IS a defect — it is just a defect in configuration or in the
   * call site, not in the transport. One line per name per process makes it findable without
   * making it loud. Like `recordIngestOutcome`, this must never route through `logToAxiom`.
   */
  function reportUnprovisionedDatastream(datastream: string) {
    if (unprovisionedReported.has(datastream)) return;
    unprovisionedReported.add(datastream);
    console.error(
      JSON.stringify({
        name: 'axiom-datastream-unprovisioned',
        type: 'error',
        level: 'error',
        pod: config.podName,
        datastream,
        message:
          'No Axiom dataset backs this datastream; skipping the Axiom dual-write. The event is on the stderr/log-store path. Provision the dataset and add it to PROVISIONED_AXIOM_DATASTREAMS (or AXIOM_EXTRA_DATASTREAMS), or drop the datastream argument at the call site.',
      })
    );
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
       * 🔴 THE PROVISIONED-DATASET GUARD. Only a datastream that names a dataset known to EXIST may
       * reach `ingestEvents`. Everything else stops here, having already been written to stderr →
       * the log store by the unconditional write above.
       *
       * WHY A GUARD AND NOT A CALL-SITE EDIT. The defect this closes was TEN distinct datastream
       * names, spread over 18 production call sites in four subsystems, every one of them rejected
       * on every write. Fixing that per call site fixes the ten that exist today and does nothing
       * about the eleventh, because the property "this string names a real dataset" is not
       * expressible at
       * a call site — it is a relationship between the source and a third-party account. One place
       * to state it, one place to check it.
       *
       * 🔴 WHY NOT "JUST DROP THE SECOND ARGUMENT". Because that does not disable the write, it
       * REDIRECTS it: `datastream ??= config.datastream` a few lines above means an omitted
       * argument falls back to the default dataset. For a high-volume stream that silently moves
       * its whole volume onto the main dataset's ingest bill, and it also rewrites the `_axiom`
       * field on the stderr line, which is the field existing log queries group by. Keeping the
       * name and refusing the write preserves both the query surface and the bill.
       *
       * The events are not lost and never were: the stderr line above carries the complete payload,
       * and it is what every consumer of these streams already reads.
       */
      if (!config.provisionedDatastreams.has(datastream)) {
        reportUnprovisionedDatastream(datastream);
        return;
      }

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
       * 🔴 THE PAIRING AND THE RACE ARE BOTH LOAD-BEARING, FOR DIFFERENT FAILURE MODES. Keep
       * both. Three earlier versions of this comment each named one of them as the only one
       * that mattered; all three were wrong, so these are stated from a node probe with a
       * positive control (a promise nobody subscribes to, which does leak):
       *
       *   - THE PAIRING converts a rejection into the value `'error'`, so the awaited race
       *     RESOLVES instead of rejecting into the caller. Measured: for an ingest that
       *     rejects INSIDE the budget, a bare or fulfilment-handler-only promise gives `THREW`
       *     while the paired one gives `'error'`. Precisely scoped: it re-creates a
       *     caller-side throw for rejections inside the budget (an ECONNREFUSED shape), NOT
       *     for the 30 s axios timeout the incident above describes — that one is already
       *     outside the 2 s budget and resolves as `'timeout'` either way.
       *   - THE RACE is what bounds the CALLER (see "WHY A RACE AND NOT JUST A TRY/CATCH"
       *     above). ⚠️ It is NOT here to prevent unhandled rejections: with no race there is no
       *     budget, nothing is ever abandoned, and that hazard does not arise. Measured, once
       *     raced, paired handlers / trailing `.catch` / fulfilment-only / bare ALL produce
       *     zero unhandled rejections — which is why the test that appears to cover this is
       *     labelled an invariant guard, and why "the race prevents the leak" is a theory this
       *     comment has already retracted once. Do not re-derive it.
       *
       * Neither substitutes for the other. `.then(onOk).catch(onErr)` would be equivalent to
       * the paired form; what is NOT equivalent is dropping either the rejection handler or
       * the race.
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
        recordIngestOutcome(await Promise.race([ingest, budget]), datastream);
      } finally {
        clearTimeout(timer);
      }
    } else {
      console.log('logToAxiom', sendData);
    }
  }

  return { logToAxiom, safeError };
}
