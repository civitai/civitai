import { env } from '$env/dynamic/private';
import { SMITES } from './config';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

/** The main app owns `resetPlayer`, so the reset has one implementation. It answers 200 once the career is reset or no longer due; anything else throws and is retried. */
export async function resetPlayerInMainApp(playerId: number): Promise<void> {
  const token = env.WEBHOOK_TOKEN;
  // The endpoint answers 503 to a blank secret and compares the presented token untrimmed, so send it as configured.
  if (!token?.trim()) throw new Error('WEBHOOK_TOKEN is not configured');

  const base = trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');
  const res = await fetch(`${base}/api/mod/knights/reset-player`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-token': token },
    body: JSON.stringify({ playerId, limit: SMITES.max }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`main app refused the reset (${res.status})`);
  const body: unknown = await res.json().catch(() => null);
  const outcome = (body as { outcome?: unknown } | null)?.outcome;
  if (outcome !== 'reset' && outcome !== 'not-due') {
    throw new Error('main app answered with an outcome this app does not know');
  }
}
