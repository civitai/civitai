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
 * The base URL and service token, read here and nowhere else: a second reader of
 * `ORCHESTRATOR_ACCESS_TOKEN` is how the app ended up with two different answers about which env var
 * counts (see `xguard-api.ts`, which also falls back to `ORCHESTRATOR_TOKEN`).
 */
function orchestratorConfig(): { base: string; token: string } | null {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) return null;
  return { base: endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint, token };
}

/** 404 and 410 are the orchestrator saying the workflow does not exist; every other failure (status 0
 *  for a transport error) means it could not be asked. Folding the second into the first turns an
 *  outage into an empty review queue. */
export const isGoneStatus = (status: number) => status === 404 || status === 410;

/** Release (or refuse) the orchestrator's moderation gate on a paused workflow. */
export async function releaseModerationGate(
  workflowId: string,
  approved: boolean,
  /** Shown to the submitter with the ruling. Omitted from the body when empty. */
  message?: string
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const config = orchestratorConfig();
  if (!config) return { ok: false, error: 'Orchestrator is not configured.' };

  try {
    const res = await fetch(
      `${config.base}/v1/manager/workflows/${encodeURIComponent(workflowId)}/moderation-gate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
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
 * One workflow through the manager read — the same API family as the gate release.
 *
 * ⚠️ This API serialises enums PascalCase (`UnderReview`, `Succeeded`), unlike the consumer API's
 * camelCase — compare them case-insensitively.
 */
export async function getManagerWorkflow(
  workflowId: string
): Promise<
  { ok: true; workflow: unknown } | { ok: false; status: number; gone: boolean; error: string }
> {
  const config = orchestratorConfig();
  if (!config)
    return { ok: false, status: 0, gone: false, error: 'Orchestrator is not configured.' };

  try {
    const res = await fetch(
      `${config.base}/v1/manager/workflows/${encodeURIComponent(workflowId)}`,
      {
        headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok) {
      const gone = isGoneStatus(res.status);
      return {
        ok: false,
        status: res.status,
        gone,
        error: gone
          ? `Workflow ${workflowId} was not found.`
          : `The orchestrator refused the read (${res.status}).`,
      };
    }
    return { ok: true, workflow: await res.json() };
  } catch (e) {
    console.error('[orchestrator] workflow read failed', e);
    return { ok: false, status: 0, gone: false, error: 'Could not reach the orchestrator.' };
  }
}

export type BlobProbe =
  /** Viewable: `url` is where its bytes are served, on the orchestrator's own origin. */
  | { kind: 'content'; url: string }
  /** Blocked by the orchestrator's screening: it answers with its blocked-content placeholder. */
  | { kind: 'blocked' }
  /** Anything else — `status` is the orchestrator's answer (0 when it is not configured). Whether that
   *  is an answer about the item or about the orchestrator is the caller's call. */
  | { kind: 'unavailable'; status: number };

const BLOCKED_PATH = '/v2/consumer/blobs/blocked/';
const CONTENT_PATH = '/v2/consumer/blobs/content/';

/**
 * Where one consumer-uploaded blob resolves, by KEY — never a URL: the caller resolves the key from a
 * workflow it has read itself, so nothing a browser posts can choose what this asks for.
 *
 * The blob read answers with a redirect, and the redirect's TARGET is what separates a viewable item
 * from a withheld one: following it blindly would hand a moderator the placeholder image as if it
 * were the upload. Only a target on the orchestrator's own origin is accepted. Throws on a transport
 * failure.
 */
export async function probeOrchestratorBlob(
  blobKey: string,
  timeoutMs = 15_000
): Promise<BlobProbe> {
  const config = orchestratorConfig();
  if (!config) return { kind: 'unavailable', status: 0 };
  const res = await fetch(`${config.base}/v2/consumer/blobs/${encodeURIComponent(blobKey)}`, {
    headers: { authorization: `Bearer ${config.token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  void res.body?.cancel();
  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (!location) return { kind: 'unavailable', status: res.status };
  const target = new URL(location, `${config.base}/`);
  if (target.origin !== new URL(config.base).origin)
    return { kind: 'unavailable', status: res.status };
  if (target.pathname.startsWith(BLOCKED_PATH)) return { kind: 'blocked' };
  if (target.pathname.startsWith(CONTENT_PATH)) return { kind: 'content', url: target.href };
  return { kind: 'unavailable', status: res.status };
}

/**
 * The bytes behind a `probeOrchestratorBlob` content URL.
 *
 * The timeout covers reaching the response, not reading it: the body is streamed straight to the
 * browser, and a long dataset video must not be cut off partway with no error.
 */
export async function fetchOrchestratorBlobContent(url: string): Promise<Response> {
  const config = orchestratorConfig();
  if (!config || new URL(url).origin !== new URL(config.base).origin)
    throw new Error('Refusing to fetch a blob from outside the orchestrator.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    return await fetch(url, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
