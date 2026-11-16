import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { pickSessionCookies } from '~/server/utils/session-cookies';
import { trainingStudioUrl } from '~/utils/training-studio-url';

/**
 * The Training Studio server routes the embedded Studio reaches through this app, and the methods
 * each takes. These start or price a training run, or count a dataset's mature images for Review:
 * the Studio's server makes the count, so the embed sends them here rather than to the orchestrator.
 */
export const STUDIO_FORWARD_ROUTES: Readonly<Record<string, readonly string[]>> = {
  train: ['POST'],
  'continue-training': ['GET', 'POST'],
  'dataset-rating': ['POST'],
};

// A submit can outlast this and still have started the run, so a timeout is reported as unconfirmed.
const FORWARD_TIMEOUT_MS = 120_000;

/** The Studio's origin: https, or a local Studio in development only. Anything else refuses rather
 *  than send the user's session to it. */
export function studioOrigin(value = trainingStudioUrl()): string {
  const url = new URL(value);
  const local =
    process.env.NODE_ENV === 'development' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !local)
    throw new Error('The Training Studio URL must be an https origin to send the session to.');
  return url.origin;
}

/** Only the session cookies from a `Cookie` header, as the browser sent them; empty when none. */
export const sessionCookiesOf = (cookieHeader: string | undefined): string =>
  pickSessionCookies(cookieHeader) ?? '';

export type StudioForwardResult = { status: number; body: unknown };

const UNCONFIRMED: StudioForwardResult = {
  status: 502,
  body: {
    message:
      "We couldn't reach Training. If you were starting a run, check your runs before starting it again.",
  },
};

/**
 * Send one request to a Studio route as this user (their session cookies, nothing else) and return
 * its status and JSON body. A redirect or 401 means the Studio did not accept the session.
 */
export async function forwardToStudio({
  route,
  method,
  search,
  body,
  sessionCookies,
}: {
  route: string;
  method: string;
  search: string;
  body?: unknown;
  sessionCookies: string;
}): Promise<StudioForwardResult> {
  const url = `${studioOrigin()}/api/${route}${search}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        cookie: sessionCookies,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: fetchTimeoutSignal(FORWARD_TIMEOUT_MS),
    });
  } catch {
    return UNCONFIRMED;
  }
  if ((res.status >= 300 && res.status < 400) || res.status === 401)
    return { status: 401, body: { message: 'Sign in again to continue.' } };
  const json = await res.json().catch(() => null);
  // Not the Studio's JSON answer (a proxy's page, say), whatever the status: a submit may have landed.
  if (json === null) return UNCONFIRMED;
  return { status: res.status, body: json };
}
