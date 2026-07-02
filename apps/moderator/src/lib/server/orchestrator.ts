import { createCivitaiClient } from '@civitai/client';
import { env } from '$env/dynamic/private';

// Internal orchestrator client (system account). The orchestrator is an external generation service —
// NOT the main civitai app — so the spoke calling it directly is fine (it is not a main-app callback).
// Lazily constructed (like the ClickHouse client) so an unconfigured dev env doesn't crash at import.
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
