import { allCookieNames, parseCookieHeader, SESSION_COOKIE_BASE } from '@civitai/auth';
import { env } from '~/env/client';

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

const SESSION_COOKIE_NAMES = allCookieNames(SESSION_COOKIE_BASE);
// A training submit can wait on the orchestrator for a while; past this the run may still have
// started, which the Studio's own answer for an unconfirmed submit already covers.
const FORWARD_TIMEOUT_MS = 120_000;

/** The Studio's origin: https only, or a local Studio in development. Anything else refuses rather
 *  than send the user's session to it. */
export function studioOrigin(value = env.NEXT_PUBLIC_TRAINING_STUDIO_URL): string {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local)
    throw new Error(
      'NEXT_PUBLIC_TRAINING_STUDIO_URL must be an https origin to send the session to.'
    );
  return url.origin;
}

/** Only the session cookies from a `Cookie` header, re-serialised; empty when there are none. */
export function sessionCookiesOf(cookieHeader: string | undefined): string {
  const jar = parseCookieHeader(cookieHeader ?? '');
  return SESSION_COOKIE_NAMES.filter((name) => jar[name] !== undefined)
    .map((name) => `${name}=${encodeURIComponent(jar[name]!)}`)
    .join('; ');
}

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
 * its status and JSON body. A redirect means the Studio did not accept the session.
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
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch {
    return UNCONFIRMED;
  }
  // A redirect, or the Studio's own 401, means it did not accept the session.
  if ((res.status >= 300 && res.status < 400) || res.status === 401)
    return { status: 401, body: { message: 'Sign in again to continue.' } };
  const json = await res.json().catch(() => null);
  // Not the Studio's JSON answer (a proxy's page, say), whatever the status: a submit may have landed.
  if (json === null) return UNCONFIRMED;
  return { status: res.status, body: json };
}
