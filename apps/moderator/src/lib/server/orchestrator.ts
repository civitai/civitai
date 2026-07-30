import { createCivitaiClient } from '@civitai/client';
import { env } from '$env/dynamic/private';

// The orchestrator is an external service (NOT the main app), so calling it directly isn't a main-app
// callback. Lazy so an unconfigured dev env doesn't crash at import.
type OrchestratorClient = ReturnType<typeof createCivitaiClient>;
let client: OrchestratorClient | undefined;

export function getOrchestratorClient(): OrchestratorClient {
  if (!client) {
    client = createCivitaiClient({
      baseUrl: env.ORCHESTRATOR_ENDPOINT ?? '',
      // Match the main app, which defaults ORCHESTRATOR_MODE to 'dev' (a dev token on 'prod' → 401).
      env: (env.ORCHESTRATOR_MODE ?? 'dev') === 'prod' ? 'prod' : 'dev',
      auth: env.ORCHESTRATOR_ACCESS_TOKEN ?? '',
    });
  }
  return client;
}
