import type { Handle, HandleServerError } from '@sveltejs/kit';
import { civitaiAppUrl } from '$lib/server/civitai-url';
import { guard } from '$lib/server/auth';
import { applyGrants, canAccess, resolvePermissions } from '$lib/server/access';
import { loadPageAccessGrants } from '$lib/server/page-access';
import { authenticateWebhookToken, type AcceptedCredential } from '$lib/server/webhook-endpoint';
import { logAxiomError, logToAxiom } from '$lib/server/axiom';

// Where authenticated-but-not-a-moderator users get sent. A 403 would be a dead end (re-login can't
// grant the role); bounce them to the main site instead. Overridable via env for non-prod hosts.
const NON_MODERATOR_REDIRECT = civitaiAppUrl();

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

/**
 * The `event` string every credential-attribution line carries. One constant so a soak query and the
 * emit below cannot drift, and so renaming it is a visible edit rather than a silently-unmatched
 * filter.
 */
export const CREDENTIAL_ATTRIBUTION_EVENT = 'webhook credential presented';

/**
 * Records WHICH inbound service credential authenticated a request — the runtime signal that makes
 * dropping WEBHOOK_TOKEN from `acceptedTokens` a checkable claim rather than an inferred one (see the
 * header of $lib/server/webhook-endpoint).
 *
 * 🔴 EMITTED FOR EVERY CLASS, NOT JUST THE LEGACY ONE. Logging only WEBHOOK_TOKEN looks like the
 * obvious saving — it is the thing we are waiting to stop seeing — and it destroys the evidence. A
 * zero from a legacy-only emitter is indistinguishable from an emitter that was never deployed, never
 * ingested, or quietly broken, so it can never license the removal. With both classes emitted, a
 * non-zero MOD_INBOUND_TOKEN count is the IN-BAND POSITIVE CONTROL standing beside the WEBHOOK_TOKEN
 * zero in the same window and proving the instrument was live when it read zero. The pair is the
 * evidence. Do not narrow this to the legacy class.
 *
 * 🔴 NOTHING DERIVED FROM THE TOKEN'S BYTES GOES IN THE RECORD — no value, prefix, suffix, length or
 * hash. Any of those is a credential oracle on a log stream that is far more widely readable than the
 * secret store. The class NAME is the whole payload. `pathname` specifically, never `url.href` or
 * `url.search`: callers may present the token as `?token=`, so the full URL carries the secret.
 *
 * `userAgent` and `method` are here because the migration's question is not only WHETHER the legacy
 * credential is still presented but BY WHOM — a count with no way to reach the caller cannot be acted
 * on.
 *
 * Fire-and-forget, and swallows its own failure both ways a promise-returning call can fail —
 * attribution must never be the thing that breaks a request. Same contract as `logAxiomError`.
 */
function logCredentialAttribution(
  event: Parameters<Handle>[0]['event'],
  credential: AcceptedCredential
): void {
  try {
    void logToAxiom({
      type: 'info',
      event: CREDENTIAL_ATTRIBUTION_EVENT,
      credential,
      path: event.url.pathname,
      method: event.request.method,
      userAgent: event.request.headers.get('user-agent'),
    }).catch(() => {});
  } catch {
    /* see above: a logging fault must not surface as a failed moderation call */
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);
  // An /api/* request presenting a credential of its own is verified HERE and never redirected to the hub
  // login — a script needs a status code, not an HTML login page. Verifying in the hook means an invalid
  // token cannot reach a handler at all; WebhookEndpoint then decides which endpoints accept a verified
  // one. `user` is deliberately left unset: there is nobody behind a token, so nothing reached this way
  // can attribute a write.
  if (event.url.pathname.startsWith('/api/')) {
    const token = authenticateWebhookToken(event);
    // Branch on the tag and nothing else — `refused` carries a Response, and a Response is an object,
    // so an `instanceof`/`typeof` discriminator would silently start mis-sorting the moment another
    // object-shaped member is added.
    if (token.kind === 'refused') return token.response;
    if (token.kind === 'authenticated') {
      logCredentialAttribution(event, token.credential);
      // 🔴 Stays the bare string, for BOTH credential classes. Which credential authenticated is a
      // migration question and belongs in the log line above; it is NOT a privilege distinction, and
      // three call sites compare this field strictly (`!== 'webhook'` in the two endpoint wrappers,
      // truthiness in defineEndpoint). Widening it to carry the class would refuse every
      // token-authenticated request at those sites without a type error anywhere.
      event.locals.tokenClient = 'webhook';
      event.locals.grants = {};
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
  // After applyGrants, never before: the resolver reads the store it just populated.
  event.locals.grants = resolvePermissions(result.user);

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
    // Says WHY on arrival. A bare bounce is indistinguishable from the page being broken — it was
    // reported as "bulk image manager tosses you back to dashboard" by a moderator who simply had no
    // grant for it, and there was nothing on screen that could have told them otherwise.
    const denied = `/?denied=${encodeURIComponent(event.url.pathname)}`;
    return new Response(null, { status: 303, headers: { location: denied } });
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
