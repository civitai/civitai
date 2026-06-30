import type { Handle, HandleServerError } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { verifier } from '$lib/server/auth/verifier';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { allowedCorsOrigin } from '$lib/server/cors';
import { unhandledErrorsTotal } from '$lib/server/metrics';

// CORS preflight headers — credentialed, so Allow-Origin MUST echo the exact origin (never `*`).
const preflightHeaders = (origin: string) => ({
  'access-control-allow-origin': origin,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
  vary: 'Origin',
});

export const handle: Handle = async ({ event, resolve }) => {
  // CORS for SAME-SITE spokes calling /api/auth/* directly with the browser client (credentialed). Only an
  // allowlisted Origin gets headers; server-to-server proxy calls (the main app) send no Origin → unaffected.
  const corsOrigin = event.url.pathname.startsWith('/api/auth/')
    ? allowedCorsOrigin(event.request.headers.get('origin'))
    : null;

  // Preflight: answer before any auth/session work. (Without an allowed origin, OPTIONS falls through to 405.)
  if (corsOrigin && event.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: preflightHeaders(corsOrigin) });
  }

  // Populate locals.user from the session cookie. The cookie is THIN (identity only), so resolve the rich user
  // by userId from the shared cache (produce on miss) rather than trusting an embedded user. The verifier handles
  // both ES256 and legacy NextAuth JWE; verification / resolve failures are non-fatal.
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    const claims = await verifier.verifyToken(token).catch(() => null);
    const userId = Number(claims?.sub);
    if (claims && Number.isFinite(userId)) {
      event.locals.user = (await getOrProduceSessionUser(userId).catch(() => null)) ?? undefined;
      event.locals.tokenId = claims.jti;
      // Impersonation (F): the moderator's id, if this is an impersonation session — read by the exit route.
      event.locals.impersonatedBy = claims.impersonatedBy;
    }
  }

  const response = await resolve(event);
  if (corsOrigin) {
    response.headers.set('access-control-allow-origin', corsOrigin);
    response.headers.set('access-control-allow-credentials', 'true');
    response.headers.append('vary', 'Origin');
  }
  return response;
};

// Count unhandled server errors (any uncaught throw in a load/action/endpoint that reaches SvelteKit),
// then return a safe, non-leaking message. The counter inc is best-effort and runs before we build the
// response so a metrics hiccup can't change what the client sees.
export const handleError: HandleServerError = ({ error }) => {
  unhandledErrorsTotal.inc();
  console.error('unhandled server error', error);
  return { message: 'Internal Error' };
};
