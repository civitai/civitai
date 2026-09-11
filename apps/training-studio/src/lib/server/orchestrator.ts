// Server half of the orchestrator reads: builds the env-configured client and delegates to the
// client-safe cores in $lib/orchestrator-core (shared with the web-component backend).
import { createCivitaiClient } from '@civitai/client';
import { env } from '$env/dynamic/private';
import * as core from '$lib/orchestrator-core';
import type { TrainingWhatIfInput } from '$lib/orchestrator-core';
import type { GenerationItem, TrainingDetail, TrainingRow } from '$lib/data/trainingRows';
import type { Media } from '$lib/data/trainingModels';

export { isFlux2 } from '$lib/orchestrator-core';
export type { TrainingWhatIfInput } from '$lib/orchestrator-core';

export function orchestratorClient(token: string) {
  return createCivitaiClient({
    baseUrl: env.ORCHESTRATOR_ENDPOINT,
    env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

export function listTrainingWorkflows(token: string): Promise<TrainingRow[]> {
  return core.listTrainingWorkflows(orchestratorClient(token));
}

export function listGenerations(token: string, media: Media): Promise<GenerationItem[]> {
  return core.listGenerations(orchestratorClient(token), media);
}

export function trainingWhatIf(token: string, input: TrainingWhatIfInput): Promise<number | null> {
  return core.trainingWhatIf(orchestratorClient(token), input);
}

export function blobUploadUrl(token: string): Promise<{ uploadUrl: string; expiresAt: string }> {
  return core.blobUploadUrl(orchestratorClient(token));
}

export function getTrainingWorkflow(
  token: string,
  workflowId: string
): Promise<TrainingDetail | null> {
  return core.getTrainingWorkflow(orchestratorClient(token), workflowId);
}

export function getRunDataset(
  token: string,
  workflowId: string
): Promise<{ air: string; caption: string }[]> {
  return core.getRunDataset(orchestratorClient(token), workflowId);
}
