import { env } from '$env/dynamic/private';
import { storedSettings } from '../settings/runtime';

const TIMEOUT_MS = 3000;

const switchedOff = (raw: string | undefined) =>
  ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());

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
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string | null };
    return data.accessToken ?? null;
  } catch {
    return null;
  }
}

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
    if (!res.ok) console.error('knights: a live update was refused', { path, status: res.status });
  } catch (error) {
    console.error('knights: could not send a live update', { path, error });
  }
}

/** Best effort: never throws. Polling and the next page load stay the source of truth. */
export const sendTopic = (topic: string, target: string, data: unknown) =>
  post(`/topics/${encodeURIComponent(topic)}/signals/${target}`, data);

export const sendToUser = (userId: number, target: string, data: unknown) =>
  post(`/users/${userId}/signals/${target}`, data);
