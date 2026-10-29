import { mainAppSessionOrigin } from './main-app';

const CHECK_TIMEOUT_MS = 5_000;

/** The main app's answer to whether this user's model still exists (not missing, not Deleted), asked
 *  with their forwarded session cookie. Rejects when the main app gives no answer. */
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
