import { env } from '~/env/server';
import { EVIDENCE_MEDIA_TYPES } from '~/server/services/generator-evidence/evidence-meta';

export type OrchestratorConfig = { base: string; origin: string; token: string };

export function orchestratorEvidenceConfig(): OrchestratorConfig {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) throw new Error('The orchestrator is not configured.');
  const base = endpoint.replace(/\/+$/, '');
  return { base, origin: new URL(base).origin, token };
}

const BLOCKED_PATH = '/v2/consumer/blobs/blocked/';
const CONTENT_PATH = '/v2/consumer/blobs/content/';
const BLOCKED_REASON_HEADER = 'x-blocked-reason';

export async function getManagerWorkflow(config: OrchestratorConfig, workflowId: string) {
  const res = await fetch(`${config.base}/v1/manager/workflows/${encodeURIComponent(workflowId)}`, {
    headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The orchestrator refused the workflow read (${res.status}).`);
  return (await res.json()) as unknown;
}

export async function listManagerWorkflows(
  config: OrchestratorConfig,
  userId: number,
  take = 50,
  cursor?: string
) {
  const query = new URLSearchParams({ userId: String(userId), take: String(take) });
  if (cursor) query.set('cursor', cursor);
  const res = await fetch(`${config.base}/v1/manager/workflows?${query}`, {
    headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`The orchestrator refused the workflow listing (${res.status}).`);
  const body = (await res.json()) as { next?: string | null; items?: unknown[] };
  return { next: body.next ?? undefined, items: Array.isArray(body.items) ? body.items : [] };
}

export type BlobProbe =
  | { kind: 'content'; url: string }
  | { kind: 'blocked'; reason?: string }
  | { kind: 'gone'; status: number }
  | { kind: 'unavailable'; status: number; reason: string };

/**
 * Where a blob resolves, asked by key alone. Only a redirect to the orchestrator's own content route is
 * readable; a redirect to its blocked route is the placeholder and is never followed.
 */
export async function probeBlob(config: OrchestratorConfig, blobId: string): Promise<BlobProbe> {
  const res = await fetch(`${config.base}/v2/consumer/blobs/${encodeURIComponent(blobId)}`, {
    headers: { authorization: `Bearer ${config.token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  void res.body?.cancel();
  if (res.status === 404) return { kind: 'gone', status: 404 };
  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (!location) return { kind: 'unavailable', status: res.status, reason: 'no redirect' };
  const target = new URL(location, `${config.base}/`);
  const reason = res.headers.get(BLOCKED_REASON_HEADER) ?? undefined;
  if (target.origin === config.origin && target.pathname.startsWith(BLOCKED_PATH))
    return { kind: 'blocked', reason };
  if (reason) return { kind: 'blocked', reason };
  if (target.origin !== config.origin)
    return { kind: 'unavailable', status: res.status, reason: 'redirect off the orchestrator' };
  if (!target.pathname.startsWith(CONTENT_PATH))
    return { kind: 'unavailable', status: res.status, reason: 'unexpected redirect' };
  return { kind: 'content', url: target.href };
}

export type BlobContent =
  | { ok: true; body: ReadableStream<Uint8Array>; contentType: string; contentLength?: number }
  | { ok: false; reason: string; blocked?: boolean };

/**
 * The bytes behind a `probeBlob` content URL. Refuses anything that says it is withheld or is not
 * media, so a placeholder can never be taken for the original.
 */
export async function fetchBlobContent(
  config: OrchestratorConfig,
  contentUrl: string
): Promise<BlobContent> {
  const url = new URL(contentUrl);
  if (url.origin !== config.origin || !url.pathname.startsWith(CONTENT_PATH))
    return { ok: false, reason: 'not an orchestrator content URL' };
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  const refuse = (reason: string, blocked = false): BlobContent => {
    void res.body?.cancel();
    return { ok: false, reason, blocked };
  };
  if (res.headers.get(BLOCKED_REASON_HEADER)) return refuse('withheld by the orchestrator', true);
  if (res.status !== 200 || !res.body) return refuse(`content read answered ${res.status}`);
  const contentType = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (!EVIDENCE_MEDIA_TYPES.has(contentType.toLowerCase()))
    return refuse(`not media (${contentType || 'none'})`);
  const length = Number(res.headers.get('content-length'));
  return {
    ok: true,
    body: res.body,
    contentType,
    contentLength: Number.isFinite(length) && length > 0 ? length : undefined,
  };
}

/** Restarts a blob's lifetime at the orchestrator. A blob route only: no workflow is read or touched. */
export async function refreshBlob(config: OrchestratorConfig, blobId: string) {
  const res = await fetch(
    `${config.base}/v2/consumer/blobs/${encodeURIComponent(blobId)}/refresh`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(20_000),
    }
  );
  void res.body?.cancel();
  return res.ok;
}
