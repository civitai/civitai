// Server half of auto-labeling: delegates to the client-safe core in $lib/autolabel-core (shared
// with the web-component backend).
import { orchestratorClient } from './orchestrator';
import * as core from '$lib/autolabel-core';
import type { AutoLabelResult } from '$lib/autolabel-core';

export type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';

/** Poll one auto-label workflow. The caller's per-user token IS the auth scope. */
export function pollAutoLabel(
  token: string,
  workflowId: string
): Promise<{ done: boolean; results: AutoLabelResult[] }> {
  return core.pollAutoLabel(orchestratorClient(token), workflowId);
}
