import { env } from '$env/dynamic/private';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

/** An opt-out type and when anyone first switched it off, i.e. since when users could have. */
export type SilenceType = { type: string; firstSeen: Date };

function readType(value: unknown): SilenceType | null {
  const { type, firstSeen } = (value ?? {}) as { type?: unknown; firstSeen?: unknown };
  if (typeof type !== 'string' || typeof firstSeen !== 'string') return null;
  const at = new Date(firstSeen);
  return Number.isNaN(at.getTime()) ? null : { type, firstSeen: at };
}

/**
 * The opt-out types the main app registers (minus the ones this app sends), so the job can tell a
 * user who turned everything off. An empty list means "could not tell": the caller sends nothing.
 */
export async function fetchSilenceTypes(fetcher: typeof fetch = fetch): Promise<SilenceType[]> {
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
    const types = Array.isArray(body.types) ? body.types.map(readType) : null;
    if (!types || types.some((t) => t === null)) {
      throw new Error('main app answered with an unexpected shape');
    }
    if (types.length === 0) throw new Error('main app listed no types');
    return types as SilenceType[];
  } catch (error) {
    console.warn('knights: could not read the notification types to check', error);
    return [];
  }
}
