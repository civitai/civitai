import { mainAppSessionOrigin } from './main-app';

const CHECK_TIMEOUT_MS = 5_000;

/** The main app's answer to whether this user's model still counts (not missing, not deleted by its
 *  owner), asked with their forwarded session cookie. Rejects when the main app gives no answer. */
export function mainAppModelLive(cookie: string): (modelId: number) => Promise<boolean> {
  return async (modelId) => {
    const res = await fetch(
      `${mainAppSessionOrigin()}/api/training-studio/model-status?id=${modelId}`,
      { headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }
    );
    if (!res.ok) throw new Error(`model-status ${res.status}`);
    const data = (await res.json()) as { live?: unknown };
    if (typeof data.live !== 'boolean') throw new Error('model-status: no answer');
    return data.live;
  };
}

/** Which of the user's runs the main app withholds epoch data for, asked with their forwarded
 *  session cookie. Rejects when the main app gives no answer. */
export async function mainAppWithheldRuns(
  asker: { cookie: string; userId: number },
  workflowIds: string[]
): Promise<Set<string>> {
  const query = new URLSearchParams({
    workflowIds: workflowIds.join(','),
    userId: String(asker.userId),
  });
  const res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/model-status?${query}`, {
    headers: { cookie: asker.cookie },
    redirect: 'error',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`model-status ${res.status}`);
  const data = (await res.json()) as { withheld?: unknown };
  if (!Array.isArray(data.withheld) || !data.withheld.every((id) => typeof id === 'string'))
    throw new Error('model-status: no answer');
  return new Set(data.withheld);
}
