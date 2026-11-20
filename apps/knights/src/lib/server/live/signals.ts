import { env } from '$env/dynamic/private';
import { logToAxiom } from '../axiom';
import { storedSettings } from '../settings/runtime';

const TIMEOUT_MS = 3000;

const switchedOff = (raw: string | undefined) =>
  ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const base = () => env.SIGNALS_ENDPOINT?.trim().replace(/\/+$/, '') || undefined;

/**
 * Live updates run when the signal service is configured, unless the kill switch is set: the one saved on the moderator Config
 * page wins, else `KNIGHTS_SIGNALS_DISABLED`.
 */
export async function signalsEnabled(): Promise<boolean> {
  if (!base()) return false;
  return !((await storedSettings()).signalsDisabled ?? switchedOff(env.KNIGHTS_SIGNALS_DISABLED));
}

/** A SignalR access token for the player; null when live updates are off or the service fails, so the page does not connect. */
export async function getSignalsAccessToken(userId: number): Promise<string | null> {
  const endpoint = base();
  if (!endpoint || !(await signalsEnabled())) return null;
  try {
    const res = await fetch(`${endpoint}/users/${userId}/accessToken`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      tokenFailed({ userId, status: res.status });
      return null;
    }
    const data = (await res.json()) as { accessToken?: string | null };
    return data.accessToken ?? null;
  } catch (error) {
    tokenFailed({ userId, error: reason(error) });
    return null;
  }
}

const tokenFailed = (details: Record<string, unknown>) =>
  void logToAxiom({
    type: 'error',
    name: 'knights-live-token-failed',
    message: 'The signal service did not mint an access token',
    details,
  });

const sendFailed = (details: Record<string, unknown>) =>
  void logToAxiom({
    type: 'error',
    name: 'knights-live-update-failed',
    message: 'A live update did not reach the signal service',
    details,
  });

async function post(path: string, data: unknown) {
  const endpoint = base();
  if (!endpoint) return;
  try {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) sendFailed({ path, status: res.status });
  } catch (error) {
    sendFailed({ path, error: reason(error) });
  }
}

/** Best effort: never throws. Polling and the next page load stay the source of truth. */
export const sendTopic = (topic: string, target: string, data: unknown) =>
  post(`/topics/${encodeURIComponent(topic)}/signals/${target}`, data);

export const sendToUser = (userId: number, target: string, data: unknown) =>
  post(`/users/${userId}/signals/${target}`, data);
