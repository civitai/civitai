import type { Handle, HandleServerError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { guard } from '$lib/server/auth';
import { applyGrants, canAccess } from '$lib/server/access';
import { loadPageAccessGrants } from '$lib/server/page-access';
import { authenticateWebhookToken } from '$lib/server/webhook-endpoint';
import { logAxiomError } from '$lib/server/axiom';

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
  // An /api/* request presenting a credential of its own is verified HERE and never redirected to the hub
  // login — a script needs a status code, not an HTML login page. Verifying in the hook means an invalid
  // token cannot reach a handler at all; WebhookEndpoint then decides which endpoints accept a verified
  // one. `user` is deliberately left unset: there is nobody behind a token, so nothing reached this way
  // can attribute a write.
  if (event.url.pathname.startsWith('/api/')) {
    const token = authenticateWebhookToken(event);
    if (token instanceof Response) return token;
    if (token === 'webhook') {
      event.locals.tokenClient = token;
      return resolve(event);
    }
  }

  const result = await guard.check(event.request.headers.get('cookie') ?? '', event.url.href);

  if (result.status === 'login') {
    return new Response(null, { status: 302, headers: { location: result.redirect } });
  }
  if (result.status === 'forbidden') {
    return new Response(null, { status: 303, headers: { location: NON_MODERATOR_REDIRECT } });
  }

  event.locals.user = result.user;

  applyGrants(await loadPageAccessGrants());

  // Global role-tier gate — one place covering loads, actions, and endpoints. Keyed on the concrete
  // pathname (not route.id) so a dynamic route like /images/[slug] gates per-slug: /images/csam →
  // senior, /images/minor → staff. canAccess's prefix match resolves `__data.json` data requests and
  // sub-path endpoints to the right nav entry too. The `route.id &&` guard keeps static assets ungated.
  // A matched route above the user's tier bounces to the dashboard; unmatched routes fall through to 404.
  // `/api/*` endpoints are exempt: they aren't NAVIGATION paths (canAccess would deny them), they're
  // already moderator-authenticated by the guard above, and any that need a finer tier self-check.
  if (
    event.route.id &&
    !event.url.pathname.startsWith('/api/') &&
    !canAccess(result.user, event.url.pathname)
  ) {
    return new Response(null, { status: 303, headers: { location: '/' } });
  }

  return resolve(event);
};

// Without this, an uncaught throw anywhere in a load, action or endpoint is a 500 page and a stack on pod
// stdout — which is why "it errors but the action went through" could be reported for a week without
// anyone being able to say which action or why. Logged with the route rather than the raw URL: `route.id`
// is the template (`/reports/[slug]`), so failures group instead of scattering across every id, and it
// cannot carry whatever a moderator typed into a lookup box.
//
// `getClientAddress()` is deliberately not read here — it throws when there is no address to give, which
// inside the error handler would replace the real fault with a second one.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  void logAxiomError(error, {
    event: 'unhandled server error',
    // Not `name` — safeError spreads last and sets that to the error's own class.
    app: 'moderator',
    route: event.route.id,
    method: event.request.method,
    status,
    // The action a form posted to (`?/setStatus`), which is the part of the URL that says WHICH verb
    // failed. Named separately because SvelteKit keeps it in the query string, not the path.
    action: [...event.url.searchParams.keys()].find((k) => k.startsWith('/')) ?? null,
    userId: event.locals.user?.id ?? null,
  });
  // What the moderator sees. Deliberately not `error.message` — these throws carry query text and
  // internal detail, and the operator can do nothing with either.
  return { message: message || 'Internal Error' };
};
