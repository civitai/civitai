// Server half of auto-labeling: forwards to the main app's system-paid auto-label routes as this user —
// their shared .civitai.com session cookie is what authenticates the request (as in text-check.ts).
import * as core from '$lib/autolabel-core';
import type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';
import type { Media } from '$lib/data/trainingModels';
import { mainAppSessionOrigin } from './main-app';

export type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';

const TIMEOUT_MS = 15_000;

/** A non-2xx from the main app; `status` is passed through so a 429 or 403 reaches the client as-is. */
export class AutoLabelUpstreamError extends Error {
  constructor(readonly status: number | undefined, message: string) {
    super(message);
  }
}

/** The status to answer with when the main app's route fails: its 401/403/404/429 mean the same thing to
 *  the client and pass through; anything else is a 502. */
export function upstreamStatus(err: unknown): number {
  const status = err instanceof AutoLabelUpstreamError ? err.status : undefined;
  return status === 401 || status === 403 || status === 404 || status === 429 ? status : 502;
}

async function mainAppAutoLabel<T>(cookie: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/auto-label${path}`, {
      ...(body === undefined
        ? { headers: { cookie } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify(body),
          }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AutoLabelUpstreamError(undefined, (err as Error)?.message ?? 'unreachable');
  }
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!res.ok || !data)
    throw new AutoLabelUpstreamError(
      res.status,
      data?.message ?? data?.error ?? `HTTP ${res.status}`
    );
  return data;
}

/** Submit one auto-label batch; returns its workflow id to poll. Free — the system account pays. */
export async function submitAutoLabel(
  cookie: string,
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[]
): Promise<string> {
  const { workflowId } = await mainAppAutoLabel<{ workflowId?: string }>(
    cookie,
    '',
    core.autoLabelRequest(mode, media, items)
  );
  if (!workflowId) throw new AutoLabelUpstreamError(undefined, 'no workflow id returned');
  return workflowId;
}

/** Poll one auto-label workflow. The main app 404s a workflow that isn't the caller's. */
export async function pollAutoLabel(
  cookie: string,
  workflowId: string
): Promise<{ done: boolean; results: AutoLabelResult[] }> {
  return core.autoLabelResults(
    await mainAppAutoLabel<core.MainAppAutoLabelWorkflow>(
      cookie,
      `/${encodeURIComponent(workflowId)}`
    )
  );
}
