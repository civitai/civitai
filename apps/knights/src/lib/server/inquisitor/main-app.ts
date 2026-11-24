import { mainAppBase } from '../main-app-base';
import { sessionCookieName } from '@civitai/auth';
import { OverrideWriteError } from './override-error';

const TIMEOUT_MS = 8000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The main app's origin; refuses anything but https, except on a local host. */
function httpsMainAppBase(): string {
  const base = mainAppBase();
  const url = new URL(base);
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.includes(url.hostname)) {
    throw new OverrideWriteError('CIVITAI_APP_URL must be https', false);
  }
  return base;
}

/**
 * Writes an image's level as the acting moderator's ruling, through the main app so its side effects run (the moderator
 * activity record, caches, search). Forwards only that moderator's session cookie, and nothing without one; never follows
 * a redirect. Throws an `OverrideWriteError` when the main app refuses (`ambiguous` false) or gives no answer in time
 * (`ambiguous` true: it may have taken the level).
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
  const name = sessionCookieName();
  // The segment as the browser sent it, never decoded and re-encoded.
  const session = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!session || /[;\r\n]/.test(session)) return { ok: false, reason: 'no-session' };
  const base = httpsMainAppBase();
  const res = await fetch(`${base}/api/mod/image/set-nsfw-level`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${name}=${session}` },
    body: JSON.stringify({ items: [{ imageId, nsfwLevel: level }] }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new OverrideWriteError(
      `main app did not answer the rating (${(error as Error)?.name ?? 'error'})`,
      true
    );
  });
  if (!res.ok) {
    throw new OverrideWriteError(`main app refused the rating (${res.status})`, res.status >= 500);
  }
  return { ok: true };
}
