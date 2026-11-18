import { mainAppSessionOrigin } from './main-app';

const TIMEOUT_MS = 25_000;
/** A refusal past the main app's daily quota carries no Retry-After; this outlasts a job's deadline. */
const LIMITED_PAUSE_MS = 60_000;

export type MainAppRating =
  | { output: unknown }
  | { limited: true; retryAfterMs: number }
  /** A 4xx: the main app refused before submitting anything. */
  | { refused: true }
  | null;

/** One image's rater output from the main app, or null when it has none to give. */
export async function mainAppRateImage(
  cookie: string,
  key: string,
  mediaUrl: string,
  signal: AbortSignal
): Promise<MainAppRating> {
  const res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/dataset-rating`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ key, mediaUrl }] }),
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
    results?: { key?: unknown; output?: unknown }[];
  } | null;
  const hit = body?.results?.find((r) => r.key === key);
  return hit ? { output: hit.output } : null;
}
