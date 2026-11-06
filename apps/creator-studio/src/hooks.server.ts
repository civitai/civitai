import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isNavigationRequest, spokeReauthResponse, withSetCookies } from '@civitai/auth';
import { registerEnumArrayTypeParsers } from '@civitai/db/kysely';
import { guard } from '$lib/server/auth';
import { dbPool } from '$lib/server/db';
import { getLogger } from '$lib/server/logger';

const FALLBACK_REDIRECT = env.CIVITAI_APP_URL || 'https://civitai.com';

console.info(`[creator-studio] version ${__APP_VERSION__}`);

/**
 * pg has no parser for arrays of a user-defined enum — see `toDomainArray`. `init` is awaited before
 * the first request, which is why registration lives here and not at module scope.
 *
 * Fail-open, matching `instrumentation.node.ts`: a DB hiccup at boot must not stop the app serving,
 * so read sites still have to tolerate the unparsed shape.
 */
export const init: ServerInit = async () => {
  try {
    await registerEnumArrayTypeParsers(dbPool);
  } catch (err) {
    console.error('[creator-studio] enum-array type-parser registration failed (fail-open):', err);
  }
};

// Prerendered at build (no cookie), or the sign-in routes themselves, so they must resolve before the gate.
const PUBLIC_PATHS = new Set([
  '/favicon.svg',
  '/logout',
  '/api/auth/authorize',
  '/api/auth/callback',
]);
// Public landing: no forced login redirect, but still attach the user if there is one (so it can bounce
// signed-in visitors to the dashboard).
const OPTIONAL_AUTH_PATHS = new Set(['/']);

// Every resolve() must pass this, or the literal %app.version% ships in app.html's meta tag.
const withVersion = {
  transformPageChunk: ({ html }: { html: string }) =>
    html.replace('%app.version%', __APP_VERSION__),
};

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  if (PUBLIC_PATHS.has(pathname)) return resolve(event, withVersion);

  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href, {
    navigation: isNavigationRequest(event.request),
  });

  if (result.status !== 'ok') {
    if (OPTIONAL_AUTH_PATHS.has(pathname)) return resolve(event, withVersion);
    if (result.status === 'login') {
      return new Response(null, { status: 302, headers: { location: result.redirect } });
    }
    if (result.status === 'reauth') return spokeReauthResponse(result.authorize);
    return new Response(null, { status: 303, headers: { location: FALLBACK_REDIRECT } });
  }

  event.locals.user = result.user;
  return withSetCookies(await resolve(event, withVersion), result.setCookies);
};

// Unexpected server errors (thrown loads/actions) — log to Axiom; SvelteKit already returns the 500.
// 404s come through here too, and at ~700/day of scanners and stray asset requests they drown out the
// real failures — skip them so this stream only carries things worth acting on.
export const handleError: HandleServerError = async ({ error, event, status, message }) => {
  if (status === 404) return { message };

  const logger = getLogger();
  await logger.logToAxiom({
    name: 'creator-studio-server-error',
    status,
    route: event.route.id,
    userId: event.locals.user?.id,
    error: logger.safeError(error),
  });
  return { message };
};
