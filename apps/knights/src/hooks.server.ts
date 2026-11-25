import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { isNavigationRequest, spokeReauthResponse, withSetCookies } from '@civitai/auth';
import { guard } from '$lib/server/auth';
import { accessFor } from '$lib/server/access';
import { logToAxiom } from '$lib/server/axiom';
import { closedPageHtml } from '$lib/server/closed-page';
import { db } from '$lib/server/db';
import { JOB_PATHS } from '$lib/server/jobs-auth';
import { metrics } from '$lib/server/metrics';
import { readiness } from '$lib/server/readiness';
import { getCacheRedis, getSysRedis } from '$lib/server/redis';
import { getStanding } from '$lib/server/standing';
import { isWelcomeRequest, safeNext, showsNotFound, signedOutLocation } from '$lib/welcome';

const PUBLIC_PATHS = new Set([
  '/favicon.svg',
  '/robots.txt',
  '/logout',
  '/api/auth/authorize',
  '/api/auth/callback',
]);

// The probes (liveness, readiness) and Prometheus scrapes: exempt before any session, access or standing
// lookup, so a probe never depends on the hub, Flipt or the database.
const PROBE_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

// Open both Redis connections at boot instead of on the first request that needs one. Not awaited: a
// connect that hangs must not hold up serving, and a failed connect is logged and retried by the client.
export const init: ServerInit = () => {
  getSysRedis();
  getCacheRedis();
  void readiness.check();
};

const FORBIDDEN_REDIRECT = 'https://civitai.com';

const closedPage = (user: { username?: string }, reason: 'closed' | 'banned' = 'closed') =>
  new Response(
    closedPageHtml({ username: user.username, civitaiUrl: FORBIDDEN_REDIRECT, reason }),
    {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }
  );

export const handle: Handle = async ({ event, resolve }) => {
  if (PROBE_PATHS.has(event.url.pathname)) {
    return resolve(event);
  }
  if (PUBLIC_PATHS.has(event.url.pathname) || JOB_PATHS.has(event.url.pathname)) {
    return resolve(event);
  }

  const navigation = isNavigationRequest(event.request);
  const onWelcome = isWelcomeRequest(event.url);
  // The welcome page's sign-in returns to the page the visitor first asked for, not to the welcome page.
  const returnUrl = onWelcome
    ? new URL(safeNext(event.url.searchParams.get('next')), event.url.origin).href
    : event.url.href;

  const result = await guard.check(event.request.headers.get('cookie') ?? '', returnUrl, {
    navigation,
  });

  // A signed-in user must fall through to the checks below (ban, access); only signed-out visitors get the page.
  if (onWelcome && (result.status === 'login' || result.status === 'reauth')) {
    event.locals.signInUrl = result.status === 'login' ? result.redirect : result.authorize;
    return resolve(event);
  }

  if (result.status === 'login') {
    // A URL no route answers has nothing to protect: the 404 page, not a sign-in detour.
    if (showsNotFound({ url: event.url, navigation, routeId: event.route.id })) {
      return resolve(event);
    }
    const location = signedOutLocation({
      url: event.url,
      navigation,
      loginRedirect: result.redirect,
    });
    return new Response(null, { status: 302, headers: { location } });
  }
  if (result.status === 'reauth') return spokeReauthResponse(result.authorize);
  if (result.status === 'forbidden') {
    return new Response(null, { status: 303, headers: { location: FORBIDDEN_REDIRECT } });
  }

  if ((await accessFor(result.user)) === 'closed') {
    return withSetCookies(closedPage(result.user), result.setCookies);
  }

  // Read from the database, not the session: a ban lands at once. Moderators are not exempt.
  if ((await getStanding(db, result.user.id)).banned) {
    return withSetCookies(closedPage(result.user, 'banned'), result.setCookies);
  }

  event.locals.user = result.user;
  return withSetCookies(await resolve(event), result.setCookies);
};

/** Counts and logs unexpected server errors (a missing route is a 404, not one); the client keeps SvelteKit's safe message. */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  if (status >= 500) {
    metrics.unhandledError();
    void logToAxiom({
      type: 'error',
      name: 'knights-unhandled-error',
      message: error instanceof Error ? error.message : String(error),
      details: { status },
      payload: {
        route: event.route.id,
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
  return { message };
};
