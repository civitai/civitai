import type { Handle, HandleServerError } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { verifier } from '$lib/server/auth/verifier';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { allowedCorsOrigin } from '$lib/server/cors';
import { isAdminRequest, isHubAdmin } from '$lib/server/auth/admin';
import { isHubPageRequest, isTrustedSessionCaller } from '$lib/server/auth/same-origin';
import { authS2sRequestsTotal, unhandledErrorsTotal } from '$lib/server/metrics';
import { getDeviceId } from '$lib/server/auth/device';
import { callerShape, readInternalCaller } from '$lib/server/auth/s2s';
import { logAxiomError } from '$lib/server/axiom';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Session-acting routes, each with the callers it accepts. SvelteKit's form-origin check is off app-wide (see
// svelte.config.js), so these carry their own. Consent approval is body-dependent and checked in its route.
const ORIGIN_CHECKS: Record<string, (request: Request, url: URL) => boolean> = {
  '/api/auth/oauth/device-approve': isHubPageRequest,
  '/api/auth/oauth/device-deny': isHubPageRequest,
  '/login/oauth/device': isHubPageRequest,
  '/login/oauth/authorize': isHubPageRequest,
  '/api/auth/switch': isTrustedSessionCaller,
  '/api/auth/impersonate': isTrustedSessionCaller,
  '/api/auth/impersonate/exit': isTrustedSessionCaller,
  '/api/auth/accounts': isTrustedSessionCaller,
  // The main app's logout revokes the hub session server-to-server with no Origin.
  '/logout': isTrustedSessionCaller,
};

// Routes other services call with a user's session. Those that read the session through `locals` take it from
// the body when the caller uses the `internal` shape; refresh and `/session` read their own request.
const S2S_ROUTES = new Set([
  '/api/auth/refresh',
  '/api/auth/oauth/session',
  '/api/auth/switch',
  '/api/auth/accounts',
  '/api/auth/impersonate',
  '/api/auth/impersonate/exit',
  '/logout',
]);
const BODY_SESSION_ROUTES = new Set([
  '/api/auth/switch',
  '/api/auth/accounts',
  '/api/auth/impersonate',
  '/api/auth/impersonate/exit',
  '/logout',
]);

// One body for every rejection, so the response says nothing about which admin routes exist.
const forbidden = () => new Response('Forbidden', { status: 403 });

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

  const originCheck = event.route?.id ? ORIGIN_CHECKS[event.route.id] : undefined;
  if (
    originCheck &&
    MUTATING_METHODS.has(event.request.method) &&
    !originCheck(event.request, event.url)
  )
    return forbidden();

  // Populate locals.user from the session cookie. The cookie is THIN (identity only), so resolve the rich user
  // by userId from the shared cache (produce on miss) rather than trusting an embedded user. The verifier handles
  // both ES256 and legacy NextAuth JWE; verification / resolve failures are non-fatal.
  const routeId = event.route?.id ?? '';
  const cookieToken = event.cookies.get(SESSION_COOKIE);
  const internal = BODY_SESSION_ROUTES.has(routeId)
    ? await readInternalCaller(event.request)
    : null;
  const token = internal ? internal.token : cookieToken;
  event.locals.deviceId = internal ? internal.deviceId : getDeviceId(event.cookies);
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

  // Authorization for the admin area. This is the gate: it runs before any route's own code, so one check
  // covers every request method and every route under /admin, including routes added after this was written.
  // +layout.server.ts keeps its own equivalent check as a second layer.
  if (isAdminRequest(event.url.pathname, event.route?.id)) {
    // Scoped stand-in for SvelteKit's form-origin check, which is disabled app-wide for the OAuth machine
    // endpoints (see svelte.config.js).
    const origin = event.request.headers.get('origin');
    if (MUTATING_METHODS.has(event.request.method) && origin !== event.url.origin)
      return forbidden();

    if (!isHubAdmin(event.locals.user)) {
      if (!event.locals.user && event.request.method === 'GET') {
        const returnUrl = encodeURIComponent(event.url.pathname + event.url.search);
        return new Response(null, {
          status: 303,
          headers: { location: `/login?returnUrl=${returnUrl}` },
        });
      }
      return forbidden();
    }
  }

  const response = await resolve(event);
  if (S2S_ROUTES.has(routeId)) {
    authS2sRequestsTotal.inc({
      route: routeId,
      shape: callerShape(event.request, !!cookieToken),
      result: String(response.status),
    });
  }
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
  void logAxiomError(error, { event: 'unhandled server error' });
  return { message: 'Internal Error' };
};
