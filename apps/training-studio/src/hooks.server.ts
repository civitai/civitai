import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { SessionUser } from '@civitai/auth';
import { guard } from '$lib/server/auth';

// Local UI preview without OAuth: ON by default in `vite dev` so the flow is viewable without an auth
// hub; opt out with TRAINING_STUDIO_DEV_LOGIN=0 to exercise the real login against a local hub. `dev`
// is false in the built server, so this is dead code in prod regardless.
const DEV_LOGIN = dev && process.env.TRAINING_STUDIO_DEV_LOGIN !== '0';
const DEV_USER = { id: 0, username: 'dev-preview' } as unknown as SessionUser;

// AUTH ADAPTER — read the Cookie header → ask the shared spoke guard → act. The guard's decision logic is
// framework-agnostic (@civitai/auth `createSpokeGuard`); only this hook is SvelteKit-specific.
//
//   login     → no valid session → redirect to the hub login, returning here afterward
//   forbidden → signed in but fails `require` → redirect to civitai.com (not a 403 — re-login can't help)
//   ok        → authenticated user → populate locals.user and continue
//
// Public paths that must resolve without a session — the brand favicon (also prerendered at build, where
// there is no cookie). Everything else is gated.
const PUBLIC_PATHS = new Set(['/favicon.svg']);

const FORBIDDEN_REDIRECT = 'https://civitai.com';

export const handle: Handle = async ({ event, resolve }) => {
  if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);

  if (DEV_LOGIN) {
    event.locals.user = DEV_USER;
    event.locals.devPreview = true;
    return resolve(event);
  }

  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href);

  if (result.status === 'login') {
    return new Response(null, { status: 302, headers: { location: result.redirect } });
  }
  if (result.status === 'forbidden') {
    return new Response(null, { status: 303, headers: { location: FORBIDDEN_REDIRECT } });
  }

  event.locals.user = result.user;
  return resolve(event);
};
