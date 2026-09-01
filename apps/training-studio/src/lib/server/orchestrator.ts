import { createCivitaiClient, queryWorkflows } from '@civitai/client';
import { env } from '$env/dynamic/private';
import { CIVITAI_TAG, TRAINING_TAG, workflowToRow, type TrainingRow } from '$lib/data/trainingRows';

/** Days of history the reconnect list pulls — matches the main app's 30-day workflow retention. */
const RETENTION_DAYS = 30;

export function orchestratorClient(token: string) {
  return createCivitaiClient({
    baseUrl: env.ORCHESTRATOR_ENDPOINT,
    env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

/** The caller's training runs from the orchestrator, newest first, mapped to list rows. */
export async function listTrainingWorkflows(token: string): Promise<TrainingRow[]> {
  const fromDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await queryWorkflows({
    client: orchestratorClient(token),
    query: { tags: [CIVITAI_TAG, TRAINING_TAG], take: 100, fromDate, hideMatureContent: false },
  });
  if (!data) throw new Error(`queryWorkflows failed: ${error?.detail ?? 'no data returned'}`);
  return (data.items ?? []).map(workflowToRow).filter((r): r is TrainingRow => r !== null);
}
