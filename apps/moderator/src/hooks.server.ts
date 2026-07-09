import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { guard } from '$lib/server/auth';

// Where authenticated-but-not-a-moderator users get sent. A 403 would be a dead end (re-login can't
// grant the role); bounce them to the main site instead. Overridable via env for non-prod hosts.
const NON_MODERATOR_REDIRECT = env.CIVITAI_APP_URL || 'https://civitai.com';

// AUTH ADAPTER — read the Cookie header → ask the shared spoke guard → act. The guard's decision logic is
// framework-agnostic (@civitai/auth `createSpokeGuard`); only this hook is SvelteKit-specific. Runs on the
// Node runtime, so the guard can resolve the rich user via redis/the hub identity endpoint.
//
//   login     → no valid session  → redirect to the hub login, returning here afterward
//   forbidden → signed in, not mod → redirect to civitai.com (not a 403 — re-login can't help)
//   ok        → authenticated moderator → populate locals.user and continue
// Public paths that must resolve without a session — the brand favicon (also prerendered at build,
// where there is no cookie). Everything else is gated.
const PUBLIC_PATHS = new Set(['/favicon.svg']);

export const handle: Handle = async ({ event, resolve }) => {
  if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);

  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href);

  if (result.status === 'login') {
    return new Response(null, { status: 302, headers: { location: result.redirect } });
  }
  if (result.status === 'forbidden') {
    return new Response(null, { status: 303, headers: { location: NON_MODERATOR_REDIRECT } });
  }

  event.locals.user = result.user;
  return resolve(event);
};
