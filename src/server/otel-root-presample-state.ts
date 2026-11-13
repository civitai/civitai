// The shared state behind root pre-sampling (~/server/otel-root-presample). Import-free, so the
// module that installs the gate (~/server/utils/otel-withspan-gate, imported by many server modules)
// does not pull the trace SDK into their graphs.
//
// On `globalThis`: the gate is installed from a dynamically imported module after the SDK starts,
// while the hook and the id generator are built in src/instrumentation.node.ts. A module-scope copy
// in a second emitted chunk would never see the gate (a dark, partial rollout with no error), and
// an id stashed by one copy's hook would never reach the other copy's id generator. Enrolled as
// SHARED_STATE in scripts/server-graph-watchlist.mjs.

export type RootPresampleState = {
  gate: (() => boolean) | undefined;
  /** Set by the hook for a pre-sampled request; taken by the next root span's trace id. */
  pendingTraceId: string | undefined;
};

declare global {
  // eslint-disable-next-line no-var
  var __civitaiOtelRootPresample: RootPresampleState | undefined;
}

export const rootPresampleState = (globalThis.__civitaiOtelRootPresample ??= {
  gate: undefined,
  pendingTraceId: undefined,
});

/** Runs on every inbound request without a traceparent, so the gate must stay cheap. */
export function setRootPresampleGate(gate: (() => boolean) | undefined): void {
  rootPresampleState.gate = gate;
}
