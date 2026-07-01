// The external orchestrator SDK client (@civitai/client). Mirrors the monolith's
// services/orchestrator/client.ts: submit/get/cancel workflow on the EXTERNAL orchestrator. A per-user
// client is minted with that user's orchestrator token; the internal client uses the system access token.
//
// P0: the factory is wired to prove the @civitai/client import + connection config (baseUrl/env/auth). No
// generation feature calls it yet — workflows.ts / orchestration-new.service.ts move in P2.

import { createCivitaiClient } from '@civitai/client';

/** Build a per-user orchestrator client bound to that user's minted orchestrator token. */
export function createOrchestratorClient(token: string) {
  return createCivitaiClient({
    baseUrl: process.env.ORCHESTRATOR_ENDPOINT ?? '',
    env: process.env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

/** The system-user orchestrator client (internal operations). Lazy so it doesn't build at module load. */
let _internal: ReturnType<typeof createOrchestratorClient> | undefined;
export function getInternalOrchestratorClient() {
  return (_internal ??= createOrchestratorClient(process.env.ORCHESTRATOR_ACCESS_TOKEN ?? ''));
}
