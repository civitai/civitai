// The registration seam between the app's structured logger and any additional sink
// (today: the OTel logs bridge). It exists as its own module for ONE reason — the object
// below must be a process-wide singleton, and that is not something a module-scope
// `const` can give you here.
//
// ---------------------------------------------------------------------------
// 🔴 WHY globalThis, and not a module-scope object
// ---------------------------------------------------------------------------
// The bundler emits `src/server/logging/client.ts` MANY times into the server build. It
// is not one module at runtime: Turbopack merges source modules into larger runtime
// modules, and `logging/client.ts` is inlined into every merged module that reaches it.
// Measured on a production build of this repo (`next build`, reading the emitted server
// source maps): **14 distinct emitted copies** — 7 under `.next/server/chunks/` and 7
// under `.next/server/chunks/ssr/`.
//
// Each copy carries its own top-level bindings, so a module-scope `const sink = {}` is
// FOURTEEN independent objects, and `setStructuredLogSink()` — called once, from
// `src/instrumentation.node.ts` at boot — mutates exactly one of them. Every log call
// resolved through any other copy sees a permanently empty sink: no error, no counter, no
// symptom other than the records not being there.
//
// That is not a hypothesis. It is what the first production window of the bridge
// measured: `eventloop-longtask` — the one call site the build merges into the SAME
// runtime module as `instrumentation.node.ts` — delivered 8 of 8 records, while every
// other call site delivered 0. Same `emitOtelLog` function, same registered provider,
// different `sink` object.
//
// `globalThis` is the one thing all of those copies genuinely share: it is the real V8
// global of the single Node process, so it is indifferent to how the bundler splits,
// merges or duplicates modules. The same reasoning (and the same idiom) is why
// `__civitaiInstrumentationRegistry` exists in `@civitai/telemetry`'s prom helpers, and
// why `global.collectMetricsInitialized` guards the default-metrics collector — this is
// the established cross-graph pattern in this codebase, not a new trick.
//
// ---------------------------------------------------------------------------
// Why this is a separate file from `./client`
// ---------------------------------------------------------------------------
// `./client` is reachable from the CLIENT bundle (`src/pages/_app.tsx` → system-cache →
// fail-open-log → here), so it must stay free of server-only imports. This module has NO
// runtime imports at all — the `AxiomDeps`/`EmitLog` imports are `import type`, erased at
// compile time — so it adds no edge to any graph, and `src/instrumentation.node.ts` can
// depend on it without dragging `./client`'s dependencies anywhere new.
import type { AxiomDeps, EmitLog } from '@civitai/axiom/client';

declare global {
  // eslint-disable-next-line no-var
  var __civitaiStructuredLogSink: AxiomDeps | undefined;
}

/**
 * The ONE `AxiomDeps` object handed to `createAxiomLogger`, shared by every emitted copy
 * of the logger shim in the process.
 *
 * `??=` rather than a plain assignment: the second (third, fourteenth) copy of this
 * module to evaluate must ADOPT the existing object, not replace it — replacing it would
 * orphan the logger instances that already closed over the previous one, which is the
 * original bug wearing a different hat.
 */
export const structuredLogSink: AxiomDeps = (globalThis.__civitaiStructuredLogSink ??= {});

/**
 * Attach an additional sink for every structured log record. Server-only callers.
 *
 * Additive: it cannot change or break the stderr write or the Axiom dual-write, and a
 * sink that throws is contained by the logger. Mutates the shared object in place — the
 * logger reads `deps.emitLog` per call, so registering after the logger is built still
 * takes effect (pinned by a test in `@civitai/axiom`).
 */
export function setStructuredLogSink(emitLog: EmitLog): void {
  structuredLogSink.emitLog = emitLog;
}
