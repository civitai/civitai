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
      // Default 'prod' (the dev orchestrator is effectively unused); the token's env must match this mode
      // or the orchestrator 401s.
      env: (env.ORCHESTRATOR_MODE ?? 'prod') === 'dev' ? 'dev' : 'prod',
      auth: env.ORCHESTRATOR_ACCESS_TOKEN ?? '',
    });
  }
  return client;
}
