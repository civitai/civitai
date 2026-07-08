import type { Handle, HandleServerError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { guard } from '$lib/server/auth';
import { getLogger } from '$lib/server/logger';

const FALLBACK_REDIRECT = env.CIVITAI_APP_URL || 'https://civitai.com';

// Prerendered at build (no cookie), so it must resolve before the gate.
const PUBLIC_PATHS = new Set(['/favicon.svg']);

export const handle: Handle = async ({ event, resolve }) => {
  if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);

  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href);

  if (result.status === 'login') {
    return new Response(null, { status: 302, headers: { location: result.redirect } });
  }
  if (result.status === 'forbidden') {
    return new Response(null, { status: 303, headers: { location: FALLBACK_REDIRECT } });
  }

  event.locals.user = result.user;
  return resolve(event);
};

// Unexpected server errors (thrown loads/actions) — log to Axiom; SvelteKit already returns the 500.
export const handleError: HandleServerError = async ({ error, event, status, message }) => {
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
