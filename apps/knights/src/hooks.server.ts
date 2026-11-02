import type { Handle } from '@sveltejs/kit';
import { isNavigationRequest, spokeReauthResponse, withSetCookies } from '@civitai/auth';
import { guard } from '$lib/server/auth';
import { accessFor } from '$lib/server/access';
import { closedPageHtml } from '$lib/server/closed-page';
import { JOB_PATHS } from '$lib/server/jobs-auth';

const PUBLIC_PATHS = new Set([
  '/favicon.svg',
  '/logout',
  '/api/auth/authorize',
  '/api/auth/callback',
]);

const FORBIDDEN_REDIRECT = 'https://civitai.com';

const closedPage = (user: { username?: string }) =>
  new Response(closedPageHtml({ username: user.username, civitaiUrl: FORBIDDEN_REDIRECT }), {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

export const handle: Handle = async ({ event, resolve }) => {
  if (PUBLIC_PATHS.has(event.url.pathname) || JOB_PATHS.has(event.url.pathname)) {
    return resolve(event);
  }

  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href, {
    navigation: isNavigationRequest(event.request),
  });

  if (result.status === 'login') {
    return new Response(null, { status: 302, headers: { location: result.redirect } });
  }
  if (result.status === 'reauth') return spokeReauthResponse(result.authorize);
  if (result.status === 'forbidden') {
    return new Response(null, { status: 303, headers: { location: FORBIDDEN_REDIRECT } });
  }

  if ((await accessFor(result.user)) === 'closed') {
    return withSetCookies(closedPage(result.user), result.setCookies);
  }

  event.locals.user = result.user;
  return withSetCookies(await resolve(event), result.setCookies);
};
