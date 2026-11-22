import { allowedCorsOrigin } from '$lib/server/cors';

/** The origin a request names: its Origin header, else its Referer's origin. Null when it sends neither. */
export function requestSource(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const referer = request.headers.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return 'null';
  }
}

/** The request came from a hub page. A request naming no origin at all is refused. */
export function isHubPageRequest(request: Request, url: URL): boolean {
  return requestSource(request) === url.origin;
}

/**
 * A hub page, an allowlisted same-site spoke (the browser client), or a request naming no origin: the
 * server-side proxies (main app, creator-studio) forward the user's cookie with neither header, and a
 * browser always sends Origin on a cross-origin POST.
 */
export function isTrustedSessionCaller(request: Request, url: URL): boolean {
  const source = requestSource(request);
  return source === null || source === url.origin || allowedCorsOrigin(source) !== null;
}

/** Response headers for a page whose buttons act on the session: no other origin may frame it. */
export const NO_FRAMING = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

function setNoFraming(headers: Headers) {
  const ancestors = NO_FRAMING['content-security-policy'];
  const csp = headers.get('content-security-policy');
  if (!csp) headers.set('content-security-policy', ancestors);
  else if (!/frame-ancestors/i.test(csp))
    headers.set('content-security-policy', `${csp}; ${ancestors}`);
  if (!headers.has('x-frame-options'))
    headers.set('x-frame-options', NO_FRAMING['x-frame-options']);
}

/** Adds NO_FRAMING to a response, keeping any CSP or frame policy it already carries. */
export function refuseFraming(response: Response): Response {
  try {
    setNoFraming(response.headers);
    return response;
  } catch {
    // Response.redirect() and fetched responses have immutable headers.
    const copy = new Response(response.body, response);
    setNoFraming(copy.headers);
    return copy;
  }
}
