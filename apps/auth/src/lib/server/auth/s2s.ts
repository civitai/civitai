import { isInternalRequest } from './internal';
import { bearerToken } from './request';
import { requestSource } from './same-origin';

// Server-to-server calls arrive in one of two shapes: the caller's service credential as the Bearer with the
// session in a JSON body (`internal`), or the session itself as the credential (a forwarded cookie, or the
// token as the Bearer on refresh). Both are accepted; the shape label is how the old one is watched to zero.
export type CallerShape = 'internal' | 'bearer' | 'cookie' | 'browser' | 'none';

export interface InternalCaller {
  token?: string;
  deviceId?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** The session named in the body of an `internal`-shape call, or null for any other shape. */
export async function readInternalCaller(request: Request): Promise<InternalCaller | null> {
  if (!isInternalRequest(request)) return null;
  // A clone, so the route can still read its own fields (e.g. `userId`) from the same body.
  const body = (await request
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return { token: str(body?.token), deviceId: str(body?.deviceId) };
}

export function callerShape(request: Request, hasSessionCookie: boolean): CallerShape {
  if (isInternalRequest(request)) return 'internal';
  if (bearerToken(request)) return 'bearer';
  if (!hasSessionCookie) return 'none';
  // Server proxies forward the cookie with no Origin or Referer; a browser always names one.
  return requestSource(request) === null ? 'cookie' : 'browser';
}
