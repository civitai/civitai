import { mainAppSessionOrigin } from './main-app';

const TIMEOUT_MS = 25_000;
/** The pause for a 429 that carries no Retry-After: past a job's deadline. */
const LIMITED_PAUSE_MS = 60_000;

export type MainAppRating =
  /** The main app's verdict at the user's mature level; null when the rater gave none. */
  | { mature: boolean | null }
  | { limited: true; retryAfterMs: number }
  /** A 4xx: the main app refused before submitting anything. */
  | { refused: true }
  | null;

/** One image's verdict from the main app, or null when the request failed. */
export async function mainAppRateImage(
  cookie: string,
  key: string,
  mediaUrl: string,
  matureLevel: number,
  signal: AbortSignal
): Promise<MainAppRating> {
  const res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/dataset-rating`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ key, mediaUrl }], matureLevel }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    return {
      limited: true,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : LIMITED_PAUSE_MS,
    };
  }
  if (res.status >= 400 && res.status < 500) return { refused: true };
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    results?: { key?: unknown; mature?: unknown }[];
  } | null;
  const hit = body?.results?.find((r) => r.key === key);
  if (!hit) return null;
  // No `mature` field at all is a main app that predates the bit: nothing usable came back.
  if (!('mature' in hit)) return { refused: true };
  return { mature: typeof hit.mature === 'boolean' ? hit.mature : null };
}
