import { siteCookieHeader } from '@civitai/auth';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { pickSessionCookies } from '~/server/utils/session-cookies';
import { trainingStudioUrl } from '~/utils/training-studio-url';

/**
 * The Training Studio server routes the embedded Studio reaches through this app, and the methods
 * each takes: every call that spends (a training run, an edit, a suggestion, an epoch archive),
 * pricing a continuation, Review's mature count (the Studio's server makes the count), and the
 * base model licences the user must accept before training.
 */
export const STUDIO_FORWARD_ROUTES: Readonly<Record<string, readonly string[]>> = {
  train: ['POST'],
  'continue-training': ['GET', 'POST'],
  'dataset-rating': ['POST'],
  'edit-image': ['POST'],
  'suggest-instruction': ['POST'],
  'epoch-archive': ['POST'],
  license: ['GET', 'POST'],
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

/**
 * Only the session cookies from a `Cookie` header, as the browser sent them, that the request's site reads;
 * empty when none.
 */
export const sessionCookiesOf = (
  cookieHeader: string | undefined,
  host: string | undefined
): string => pickSessionCookies(siteCookieHeader(cookieHeader ?? '', host)) ?? '';

export type StudioForwardResult = { status: number; body: unknown };

const UNCONFIRMED: StudioForwardResult = {
  status: 502,
  body: {
    message:
      "We couldn't reach Training. If you were starting a run, check your runs before starting it again.",
  },
};

const NOT_STARTED: StudioForwardResult = {
  status: 403,
  body: { message: "Training didn't start. Reload the page and try again." },
};

// Far above any Studio answer; a larger body is not one.
const MAX_BODY_CHARS = 1_000_000;

/** The response's JSON, or null for a body that is not JSON, is too large, or can't be read. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
    res = await outboundFetch(url, {
      method,
      headers: {
        cookie: sessionCookies,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      timeoutMs: FORWARD_TIMEOUT_MS,
    });
  } catch {
    return UNCONFIRMED;
  }
  if ((res.status >= 300 && res.status < 400) || res.status === 401)
    return { status: 401, body: { message: 'Sign in again to continue.' } };
  const json = await readJson(res);
  // No readable JSON. The Studio answers 403 only before anything is submitted (its closed-beta
  // page, a withheld run); any other status, a 2xx included, may follow a submit that landed.
  if (json === null) return res.status === 403 ? NOT_STARTED : UNCONFIRMED;
  return { status: res.status, body: json };
}
