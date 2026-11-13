// The shared state behind root pre-sampling (~/server/otel-root-presample). Import-free, so the
// module that installs the gate (~/server/utils/otel-withspan-gate, imported by many server modules)
// does not pull the trace SDK into their graphs.
//
// On `globalThis`: the gate is installed from a dynamically imported module after the SDK starts,
// while the hook and the sampler are built in src/instrumentation.node.ts. A module-scope copy in a
// second emitted chunk would never see the gate (a dark, partial rollout with no error), and a mark
// set by one copy's hook would never reach the other copy's sampler. Enrolled as SHARED_STATE in
// scripts/server-graph-watchlist.mjs.

export type RootPresampleState = {
  gate: (() => boolean) | undefined;
  /** Set by the hook for a pre-sampled request; consumed by the next root SERVER sampling call. */
  pendingSampled: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __civitaiOtelRootPresample: RootPresampleState | undefined;
}

export const rootPresampleState = (globalThis.__civitaiOtelRootPresample ??= {
  gate: undefined,
  pendingSampled: false,
});

/** Install (or, with `undefined`, remove) the switch. Called on every inbound request: keep it cheap. */
export function setRootPresampleGate(gate: (() => boolean) | undefined): void {
  rootPresampleState.gate = gate;
}
