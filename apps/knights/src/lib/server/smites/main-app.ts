import { env } from '$env/dynamic/private';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

/** The main app owns `resetPlayer`, so the reset has one implementation. It answers 200 once the career is reset or no longer due; anything else throws and is retried. */
export async function resetPlayerInMainApp(playerId: number): Promise<void> {
  const token = env.WEBHOOK_TOKEN;
  if (!token) throw new Error('WEBHOOK_TOKEN is not configured');

  const base = trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');
  const res = await fetch(`${base}/api/mod/knights/reset-player`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-token': token },
    body: JSON.stringify({ playerId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`main app refused the reset (${res.status})`);
  const body: unknown = await res.json().catch(() => null);
  const outcome = (body as { outcome?: unknown } | null)?.outcome;
  if (outcome !== 'reset' && outcome !== 'not-due') {
    throw new Error('main app answered with an outcome this app does not know');
  }
}
