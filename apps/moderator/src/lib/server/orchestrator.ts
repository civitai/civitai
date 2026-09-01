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

/**
 * Here rather than in the caller because the base URL and the credentials are this module's job: a
 * second reader of `ORCHESTRATOR_ACCESS_TOKEN` is how the app ended up with two different answers about
 * which env var counts (see `xguard-api.ts`, which also falls back to `ORCHESTRATOR_TOKEN`).
 */
export async function releaseModerationGate(
  workflowId: string,
  approved: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) return { ok: false, error: 'Orchestrator is not configured.' };

  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  try {
    const res = await fetch(`${base}/v1/manager/workflows/${workflowId}/moderation-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ approved }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      return {
        ok: false,
        error:
          res.status === 429
            ? 'The orchestrator is rate-limiting; try again shortly.'
            : `The orchestrator refused the gate update (${res.status}).`,
      };
    return { ok: true };
  } catch (e) {
    console.error('[orchestrator] gate update failed', e);
    return { ok: false, error: 'Could not reach the orchestrator.' };
  }
}
