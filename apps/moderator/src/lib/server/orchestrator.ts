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
 * Release (or refuse) the orchestrator's moderation gate on a paused workflow.
 *
 * Here rather than in the caller because the base URL and the credentials are this module's job: a
 * second reader of `ORCHESTRATOR_ACCESS_TOKEN` is how the app ended up with two different answers about
 * which env var counts (see `xguard-api.ts`, which also falls back to `ORCHESTRATOR_TOKEN`).
 */
export async function releaseModerationGate(
  workflowId: string,
  approved: boolean,
  /** Shown to the submitter with the ruling. Omitted from the body when empty. */
  message?: string
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) return { ok: false, error: 'Orchestrator is not configured.' };

  try {
    const res = await fetch(
      `${baseUrl(endpoint)}/v1/manager/workflows/${encodeURIComponent(workflowId)}/moderation-gate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(message ? { approved, message } : { approved }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 429
            ? 'The orchestrator is rate-limiting; try again shortly.'
            : res.status === 404
            ? 'The orchestrator has no pending gate on this workflow (404) — it may already have been ruled on or expired. Reload before trying again.'
            : `The orchestrator refused the gate update (${res.status}).`,
      };
    return { ok: true };
  } catch (e) {
    console.error('[orchestrator] gate update failed', e);
    return { ok: false, error: 'Could not reach the orchestrator.' };
  }
}

/**
 * One workflow through the MANAGER read — the same API family as the gate release, and it still answers
 * for a soft-deleted run.
 *
 * `status` separates "the orchestrator says this workflow does not exist" (404/410) from "the
 * orchestrator could not be asked" (anything else, including 0 for a transport failure). A caller that
 * folds the second into the first turns an outage into an empty review queue.
 *
 * ⚠️ This API serialises enums PascalCase (`UnderReview`, `Succeeded`), unlike the consumer API's
 * camelCase — compare them case-insensitively.
 */
export async function getManagerWorkflow(
  workflowId: string
): Promise<{ ok: true; workflow: unknown } | { ok: false; status: number; error: string }> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token)
    return { ok: false, status: 0, error: 'Orchestrator is not configured.' };

  try {
    const res = await fetch(
      `${baseUrl(endpoint)}/v1/manager/workflows/${encodeURIComponent(workflowId)}`,
      {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 404 || res.status === 410
            ? `Workflow ${workflowId} was not found.`
            : `The orchestrator refused the read (${res.status}).`,
      };
    return { ok: true, workflow: await res.json() };
  } catch (e) {
    console.error('[orchestrator] workflow read failed', e);
    return { ok: false, status: 0, error: 'Could not reach the orchestrator.' };
  }
}

/**
 * Bytes of one consumer-uploaded blob, read with this app's service credential.
 *
 * Takes a bare blob KEY, never a URL: the caller resolves the key from a workflow it has read itself, so
 * nothing a browser posts can choose what this fetches.
 */
export async function fetchOrchestratorBlob(blobKey: string): Promise<Response | null> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) return null;
  return fetch(`${baseUrl(endpoint)}/v2/consumer/blobs/${encodeURIComponent(blobKey)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
}

const baseUrl = (endpoint: string) => (endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint);
