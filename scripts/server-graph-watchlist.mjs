/**
 * The modules whose runtime identity is load-bearing, and what must be true of each.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Two consumers need this list: `check-server-graph-singletons.mjs`, which enforces it
 * against a real build, and `__tests__/check-server-graph-singletons.test.ts`, which
 * drives the gate against synthetic builds. When the test kept its own hand-written
 * fixture list instead, adding a third entry here broke the test's POSITIVE CONTROL —
 * the new entry matched none of the fixture's chunks, so the gate's own "this rule
 * examined NOTHING" refusal fired and the healthy case went red. One list, one place:
 * the test now builds a healthy fixture FOR EVERY ENTRY, so growth cannot break it and
 * a new entry is proven satisfiable rather than merely declared.
 *
 * Keep this SMALL and justified. Every entry must name a real cross-graph invariant and
 * say what breaks when it is violated — an entry nobody can explain becomes an entry
 * nobody dares delete.
 *
 * RULES
 * -----
 *  SHARED_STATE — the module may be emitted any number of times, but every emitted copy
 *                 must reference the named `globalThis` key. A copy without it owns
 *                 private state that the registration path can never reach.
 *
 *  SINGLETON    — the module must be emitted EXACTLY once. Its module scope is
 *                 deliberately graph-local (a memoized handle, a set of counters), so a
 *                 second copy is a second, silently-unregistered instance.
 */
export const WATCHLIST = [
  {
    rule: 'SHARED_STATE',
    module: 'src/server/logging/structured-log-sink.ts',
    globalKey: '__civitaiStructuredLogSink',
    why: 'The one AxiomDeps object every emitted copy of the logger shim hands to createAxiomLogger. `src/instrumentation.node.ts` calls setStructuredLogSink() ONCE at boot; a copy holding a private object is a log call site whose additional sinks (the OTel logs bridge) are permanently dark, with no error and no counter.',
  },
  {
    rule: 'SHARED_STATE',
    module: 'src/server/logging/server-fault-override.ts',
    globalKey: '__civitaiServerFaultOverrides',
    why: 'The one WeakSet recording which thrown errors are SERVER faults despite a 4xx tRPC code. The marker is added by throwers (e.g. `~/server/recaptcha/client`) and read by `classifyErrorFault` in `~/server/logging/client` — a module the bundler inlines into many emitted chunks (13 when this rule was added; this module itself, 12). A copy holding a private WeakSet answers `isEscalatedServerFault` false forever, so the escalation silently never happens: the fault logs as routine client feedback, with no error and no counter. Vitest cannot see this (it loads each module once), so this gate is the only check that can.',
  },
  {
    rule: 'SHARED_STATE',
    module: 'src/server/utils/request-bulkhead.ts',
    globalKey: '__civitaiBulkheadState',
    why: 'The one object holding BOTH the in-flight slot Map and the cumulative reject Map for the heavy-route bulkhead. They are mutated by the request path (the REST `/api/v1/images` handler, `/api/v1/blocks/images`, the tRPC `heavyProcedure` middleware, and the SSR `prefetchInfinite` calls on the post/model detail pages) and READ by the collect() callbacks of `civitai_app_heavy_bulkhead_active`/`_rejects` in `src/server/prom/client.ts` — a module the instrumentation entry also pulls in, so the reader and the writer genuinely can land in different graphs. This module is emitted THREE times in the production server build (measured: `[bulkhead] HEAVY_REQUEST_CONCURRENCY=` appears 3x on every pod, against one `[instrumentation] Running in nodejs runtime`). A copy holding private Maps is a bulkhead whose gauges read permanently empty state — exactly how those two metrics emitted ZERO series for 74 days while looking registered, deployed and healthy. The two maps share one key deliberately: they are one invariant, and a rule carries one globalKey, so splitting them would need two entries naming this same module — which this gate cannot express, since its fixture emits one chunk per entry carrying only the key named by that entry. Vitest cannot see any of this (it loads each module once), so this gate is the only check that can.',
  },
  {
    rule: 'SHARED_STATE',
    module: 'src/server/flipt/client.ts',
    globalKey: '__civitaiFliptClient',
    why: 'The one Flipt client, and with it the one wasm engine, the one 60s config poller and the one pair of eval caches. This module is emitted TWICE in the production server build (measured: `[flipt] eval cache TTL:` appears 2x on every pod — 488 lines across 244 pod streams — against one `[instrumentation] Running in nodejs runtime`). The caches are mutated by every flag evaluation on the request path and READ by the collect() callbacks of `civitai_app_flipt_eval_cache_*` in `src/server/metrics/flipt-eval-cache.metrics.ts`, so reader and writer can land in different graphs — the same shape that left the bulkhead gauges reading empty state for 74 days. Here the failure is worse than a zero: an unpinned copy makes the eval-cache metrics report ONE of two caches, and the bias has a direction. Rotations are superlinear in per-instance key space, so one key space split across two caches at the same ceiling rotates far less than one cache holding all of it — the split reads as "TTL-bound" and sends the reader to the knob that changes nothing, which is the exact inert change those metrics exist to prevent. Vitest cannot see this (it loads each module once), so this gate is the only check that can.',
  },
  {
    rule: 'SINGLETON',
    module: 'packages/civitai-telemetry/src/otel-logs.ts',
    why: 'Holds the memoized OTel Logger and the bridge counters in module scope, and is loaded only from the instrumentation entry, which is also what registers the LoggerProvider. A second copy would be a second bridge that never sees that registration — and whose counters register into a registry nothing scrapes.',
  },
];
