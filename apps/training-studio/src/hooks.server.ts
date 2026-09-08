import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { SessionUser } from '@civitai/auth';
import { guard } from '$lib/server/auth';
import { isTrainingStudioAllowed } from '$lib/server/flipt';

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

// A signed-in user who isn't in the closed-beta segment (see `isTrainingStudioAllowed`) gets this instead
// of the app — a plain page, not a redirect, since re-login can't help. Self-contained (the hook runs
// before SvelteKit rendering).
const closedBetaPage = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Training Studio — Closed Beta</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1a1b1e;
    color: #c1c2c5; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
  .card { max-width: 30rem; padding: 2.5rem; text-align: center; }
  h1 { color: #fff; font-size: 1.5rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; }
  a { color: #4dabf7; }
  .badge { display: inline-block; margin-bottom: 1.25rem; padding: .2rem .6rem; border-radius: 999px;
    background: rgba(77,171,247,.15); color: #4dabf7; font: 600 11px/1 ui-monospace, monospace;
    letter-spacing: .08em; text-transform: uppercase; }
</style></head>
<body><div class="card">
  <span class="badge">Closed beta</span>
  <h1>Training Studio isn't open yet</h1>
  <p>It's currently in a closed beta. Your account isn't in the beta group yet.</p>
  <p style="margin-top:1rem"><a href="https://civitai.com">← Back to Civitai</a></p>
</div></body></html>`,
    { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );

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

  // Closed-beta gate (Flipt): a signed-in user outside the segment can't use the app. Moderators always
  // pass (the fallback when the flag is absent), so the beta ships dark until the segment is configured.
  if (!(await isTrainingStudioAllowed(result.user))) {
    return closedBetaPage();
  }

  event.locals.user = result.user;
  return resolve(event);
};
