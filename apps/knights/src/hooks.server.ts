import type { Handle } from '@sveltejs/kit';
import { isNavigationRequest, spokeReauthResponse, withSetCookies } from '@civitai/auth';
import { guard } from '$lib/server/auth';
import { accessFor } from '$lib/server/access';

const PUBLIC_PATHS = new Set([
  '/favicon.svg',
  '/logout',
  '/api/auth/authorize',
  '/api/auth/callback',
]);

const FORBIDDEN_REDIRECT = 'https://civitai.com';

const closedPage = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Knights of New Order</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14110d;
    color: #d8cdb8; font: 16px/1.6 Georgia, 'Times New Roman', serif; }
  .card { max-width: 30rem; padding: 2.5rem; text-align: center; border: 1px solid #3a3025;
    background: #1e1913; }
  h1 { color: #c9a24b; font-size: 1.5rem; margin: 0 0 .75rem; letter-spacing: .04em; }
  p { margin: .25rem 0; }
  a { color: #c9a24b; }
</style></head>
<body><div class="card">
  <h1>The gates are not yet open</h1>
  <p>The Knights of New Order is not open to everyone yet.</p>
  <p style="margin-top:1rem"><a href="https://civitai.com">Back to Civitai</a></p>
</div></body></html>`,
    { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );

export const handle: Handle = async ({ event, resolve }) => {
  if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);

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

  if (accessFor(result.user) === 'closed') {
    return withSetCookies(closedPage(), result.setCookies);
  }

  event.locals.user = result.user;
  return withSetCookies(await resolve(event), result.setCookies);
};
