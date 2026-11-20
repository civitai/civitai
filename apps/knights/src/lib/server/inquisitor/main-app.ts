import { env } from '$env/dynamic/private';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);
const TIMEOUT_MS = 8000;

/**
 * Writes an image's level as the acting moderator's ruling, through the main app so its side effects run (the moderator
 * activity record, caches, search). Sends that moderator's own session; nothing is sent without one. Throws when the main
 * app refuses or does not answer in time.
 */
export async function setImageLevelAsModerator({
  cookie,
  imageId,
  level,
}: {
  cookie: string | null;
  imageId: number;
  level: number;
}): Promise<{ ok: true } | { ok: false; reason: 'no-session' }> {
  if (!cookie) return { ok: false, reason: 'no-session' };
  const base = trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');
  const res = await fetch(`${base}/api/mod/image/set-nsfw-level`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ items: [{ imageId, nsfwLevel: level }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new Error(`main app did not answer the rating (${(error as Error)?.name ?? 'error'})`);
  });
  if (!res.ok) throw new Error(`main app refused the rating (${res.status})`);
  return { ok: true };
}
