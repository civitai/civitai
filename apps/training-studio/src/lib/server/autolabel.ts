// Server half of auto-labeling: delegates to the client-safe core in $lib/autolabel-core (shared
// with the web-component backend).
import { orchestratorClient } from './orchestrator';
import * as core from '$lib/autolabel-core';
import type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';
import type { Media } from '$lib/data/trainingModels';

export type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';

/** Submit one auto-label workflow for a batch of uploaded blobs; returns its id to poll. Free. */
export function submitAutoLabel(
  token: string,
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[]
): Promise<string> {
  return core.submitAutoLabel(orchestratorClient(token), mode, media, items);
}

/** Poll one auto-label workflow. The caller's per-user token IS the auth scope. */
export function pollAutoLabel(
  token: string,
  workflowId: string
): Promise<{ done: boolean; results: AutoLabelResult[] }> {
  return core.pollAutoLabel(orchestratorClient(token), workflowId);
}
