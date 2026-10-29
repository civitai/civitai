import { env } from '$env/dynamic/private';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

/**
 * The opt-out types the main app registers (minus the ones this app sends), so the job can tell a
 * user who turned everything off. An empty list means "could not tell": the caller sends nothing.
 */
export async function fetchSilenceTypes(fetcher: typeof fetch = fetch): Promise<string[]> {
  try {
    const token = env.WEBHOOK_TOKEN;
    if (!token) throw new Error('WEBHOOK_TOKEN is not configured');
    const base = trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');
    const res = await fetcher(`${base}/api/mod/knights/notification-types`, {
      headers: { 'x-webhook-token': token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`main app answered ${res.status}`);
    const body = (await res.json()) as { types?: unknown };
    const types = body.types;
    if (!Array.isArray(types) || !types.every((t): t is string => typeof t === 'string')) {
      throw new Error('main app answered with an unexpected shape');
    }
    if (types.length === 0) throw new Error('main app listed no types');
    return types;
  } catch (error) {
    console.warn('knights: could not read the notification types to check', error);
    return [];
  }
}
