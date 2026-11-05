import type { Handle } from '@sveltejs/kit';
import { isNavigationRequest, spokeReauthResponse, withSetCookies } from '@civitai/auth';
import { guard } from '$lib/server/auth';
import { accessFor } from '$lib/server/access';
import { closedPageHtml } from '$lib/server/closed-page';
import { db } from '$lib/server/db';
import { JOB_PATHS } from '$lib/server/jobs-auth';
import { getStanding } from '$lib/server/standing';
import { isWelcomeRequest, safeNext, signedOutLocation } from '$lib/welcome';

const PUBLIC_PATHS = new Set([
  '/favicon.svg',
  '/logout',
  '/api/auth/authorize',
  '/api/auth/callback',
]);

// The liveness/readiness probe. Not a job and not a sign-in route: exempt on its own, before any
// session, access or standing lookup, so a probe never depends on the hub, Flipt or the database.
const HEALTH_PATH = '/healthz';

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
  if (event.url.pathname === HEALTH_PATH) return resolve(event);
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
