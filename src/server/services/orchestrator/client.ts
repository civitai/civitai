import { createCivitaiClient } from '@civitai/client';
import { env } from '~/env/server';

export function createOrchestratorClient(token: string) {
  return createCivitaiClient({
    baseUrl: env.ORCHESTRATOR_ENDPOINT,
    env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

/** Used to perform orchestrator operations with the system user account */
export const internalOrchestratorClient = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN);
