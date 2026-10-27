import { decodeJwt } from 'jose';
import { SPOKE_AUTHORIZE_PATH } from './constants';
import {
  deviceCookieNameForSlot,
  isSecureCookie,
  parseCookieHeader,
  sessionCookieNameForSlot,
  type CookieSlot,
} from './cookies';
import {
  buildAuthorizeRedirect,
  clearBridgeCookie,
  completeFirstPartyCallback,
  OAUTH_BRIDGE_COOKIE,
  safePath,
} from './first-party-bridge';
import { hubBaseUrl } from './hub';
import { registrableDomain } from './spoke-logout';

// Sign-in handlers for a first-party app on its own host: `GET /api/auth/authorize` and `GET /api/auth/callback`.
// They write only the host-only slot, which no other host can set; the shared slot belongs to the hub and the main
// app.

export const POST_LOGIN_MARKER = 'civ_postlogin';
export const LOGIN_RETRY_COOKIE = 'civ_login_retry';
const LOGIN_RETRY_TTL_S = 120;
const DEVICE_TTL_S = 30 * 24 * 60 * 60;

/** Header on a 401 from a spoke whose session is gone: where to send the browser to sign in again. */
export const SESSION_REAUTH_HEADER = 'x-session-reauth';

export type SpokeSignInEvent =
  | 'hub-not-configured'
  | 'cookie-miss-retry'
  | 'loop-terminal'
  | 'exchange-error'
  | 'success';

export interface SpokeSignInOptions {
  /** This app's public origin. Defaults to the request URL's origin. */
  selfOrigin?: string;
  /** Structured log hook for each outcome. */
  onEvent?: (event: SpokeSignInEvent, detail?: Record<string, unknown>) => void;
}

export interface SpokeCallbackOptions extends SpokeSignInOptions {
  /** The end-user address, forwarded to the hub on the code exchange. */
  clientIp?: string;
}

const markerCookie = () => `${POST_LOGIN_MARKER}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`;
const clearMarker = () => `${POST_LOGIN_MARKER}=; Path=/; Max-Age=0; SameSite=Lax`;
const retryCookie = (n: number) =>
  `${LOGIN_RETRY_COOKIE}=${n}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_RETRY_TTL_S}`;
const clearRetry = () => `${LOGIN_RETRY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;

function cookie(
  name: string,
  value: string,
  secure: boolean,
  maxAge?: number,
  domain?: string
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...(domain ? [`Domain=${domain}`] : []),
    ...(maxAge != null ? [`Max-Age=${maxAge}`] : []),
  ].join('; ');
}

function expire(name: string, secure: boolean): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function tokenMaxAge(token: string): number | undefined {
  try {
    const { exp } = decodeJwt(token);
    return typeof exp === 'number' ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Set-Cookie values that write a spoke session (and its device id, when given) into `slot`: host-only, or for the
 * shared slot on `hostname`'s registrable domain. Each write also expires, host-only, the other slot's name when
 * the request carries it, so the host never holds the pair.
 */
export function spokeSessionCookies(
  token: string,
  opts: {
    slot?: CookieSlot;
    hostname?: string;
    deviceId?: string;
    requestCookies?: Record<string, string | undefined>;
  }
): string[] {
  const secure = isSecureCookie();
  const slot = opts.slot ?? 'host';
  const other: CookieSlot = slot === 'host' ? 'shared' : 'host';
  const domain = slot === 'shared' && opts.hostname ? registrableDomain(opts.hostname) : undefined;
  const session = sessionCookieNameForSlot(slot, secure);
  const out = [cookie(session, token, secure, tokenMaxAge(token), domain)];
  if (opts.deviceId) {
    const device = deviceCookieNameForSlot(slot, secure);
    out.push(cookie(device, opts.deviceId, secure, DEVICE_TTL_S, domain));
  }
  for (const [mine, theirs] of [
    [session, sessionCookieNameForSlot(other, secure)],
    [deviceCookieNameForSlot(slot, secure), deviceCookieNameForSlot(other, secure)],
  ]) {
    // On http dev both slots share the bare name; expiring "the other" would delete what was just written.
    if (theirs !== mine && opts.requestCookies?.[theirs]) out.push(expire(theirs, secure));
  }
  return out;
}

/** The page shown when sign-in keeps failing to stick (the second consecutive miss). */
export function signInProblemHtml(): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in problem</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{background:#0b0c10;color:#e8eaed;font-family:system-ui,sans-serif;display:grid;` +
    `place-items:center;height:100vh;margin:0}.card{max-width:420px;padding:1.5rem;text-align:center}` +
    `h1{font-size:1.2rem;margin:0 0 .5rem}p{color:#9aa0a6;font-size:.9rem;line-height:1.5}a{color:#4285f4}` +
    `</style></head><body><div class="card"><h1>We couldn't sign you in</h1><p>Your session couldn't be ` +
    `established — this is usually a temporary cookie issue. We've cleared it; please ` +
    `<a href="/">try again</a>.</p></div></body></html>`
  );
}

function problemPage(cookies: string[]): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(signInProblemHtml(), { status: 400, headers });
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

const originOf = (request: Request, opts: SpokeSignInOptions) =>
  (opts.selfOrigin ?? new URL(request.url).origin).replace(/\/+$/, '');

/**
 * `GET /api/auth/authorize`: start the hub's authorization-code login for this host.
 *
 * The callback leaves a one-shot marker beside the session cookie it sets. Arriving here with the marker but
 * without the session cookie means that cookie did not land: the first time, retry; the second time in a row,
 * clear everything and show the problem page instead of looping.
 */
export function spokeAuthorize(request: Request, opts: SpokeSignInOptions = {}): Response {
  if (!hubBaseUrl()) {
    opts.onEvent?.('hub-not-configured');
    return new Response('hub not configured', { status: 500 });
  }
  const url = new URL(request.url);
  const jar = parseCookieHeader(request.headers.get('cookie') ?? '');
  const cookieOps: string[] = [];

  if (jar[POST_LOGIN_MARKER] && !jar[sessionCookieNameForSlot('host')]) {
    const retries = Number.parseInt(jar[LOGIN_RETRY_COOKIE] ?? '', 10) || 0;
    if (retries >= 1) {
      opts.onEvent?.('loop-terminal', { retries });
      // Only this host's own slot: the shared Domain session belongs to every other app.
      const secure = isSecureCookie();
      return problemPage([
        expire(sessionCookieNameForSlot('host', secure), secure),
        expire(deviceCookieNameForSlot('host', secure), secure),
        clearBridgeCookie(),
        clearMarker(),
        clearRetry(),
      ]);
    }
    opts.onEvent?.('cookie-miss-retry', { retries });
    cookieOps.push(clearMarker(), retryCookie(retries + 1));
  } else if (jar[LOGIN_RETRY_COOKIE]) {
    cookieOps.push(clearRetry());
  }

  const { location, setCookie } = buildAuthorizeRedirect({
    selfOrigin: originOf(request, opts),
    returnUrl: safePath(url.searchParams.get('returnUrl')),
  });
  return redirect(location, [setCookie, ...cookieOps]);
}

/** `GET /api/auth/callback`: exchange the hub's code for this host's own session cookie. */
export async function spokeCallback(
  request: Request,
  opts: SpokeCallbackOptions = {}
): Promise<Response> {
  if (!hubBaseUrl()) {
    opts.onEvent?.('hub-not-configured');
    return new Response('hub not configured', { status: 500 });
  }
  const url = new URL(request.url);
  const jar = parseCookieHeader(request.headers.get('cookie') ?? '');
  const result = await completeFirstPartyCallback({
    selfOrigin: originOf(request, opts),
    query: {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
    },
    bridgeCookieValue: jar[OAUTH_BRIDGE_COOKIE],
    clientIp: opts.clientIp,
  });

  if ('error' in result) {
    opts.onEvent?.('exchange-error', {
      error: result.error,
      detail: result.detail,
      cookieCount: Object.keys(jar).length,
    });
    return problemPage([clearBridgeCookie()]);
  }
  opts.onEvent?.('success');
  return redirect(result.returnUrl, [
    clearBridgeCookie(),
    ...spokeSessionCookies(result.token, {
      slot: 'host',
      deviceId: result.deviceId,
      requestCookies: jar,
    }),
    markerCookie(),
  ]);
}

/** Where a spoke sends a browser to sign in on its own host, coming back to `returnUrl` (same-origin) after. */
export function spokeAuthorizeUrl(returnUrl: string): string {
  const u = new URL(returnUrl);
  return `${u.origin}${SPOKE_AUTHORIZE_PATH}?returnUrl=${encodeURIComponent(
    u.pathname + u.search
  )}`;
}

/** The 401 a spoke answers a non-navigation request with when it must sign in again. */
export function spokeReauthResponse(authorize: string): Response {
  return new Response(JSON.stringify({ error: 'reauth', authorize }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      [SESSION_REAUTH_HEADER]: authorize,
    },
  });
}

/**
 * Whether a request is a top-level page load, which can follow a sign-in redirect. A SvelteKit `__data.json`
 * fetch counts: when the redirect it follows ends cross-origin, the client falls back to a full page load.
 */
export function isNavigationRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (new URL(request.url).pathname.endsWith('/__data.json')) return true;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** Append Set-Cookie values to a response, copying it first when its headers are immutable. */
export function withSetCookies(response: Response, cookies: string[]): Response {
  if (!cookies.length) return response;
  try {
    for (const c of cookies) response.headers.append('set-cookie', c);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const c of cookies) copy.headers.append('set-cookie', c);
    return copy;
  }
}
