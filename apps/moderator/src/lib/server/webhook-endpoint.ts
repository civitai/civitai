import { timingSafeEqual } from 'node:crypto';
import { error, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// WEBHOOK ENDPOINTS — the spoke's equivalent of the main app's WebhookEndpoint
// (src/server/utils/endpoint-helpers.ts). Wrap any `/api/*` handler to make it callable by a service
// holding an accepted service token instead of by a signed-in moderator:
//
//   export const POST = WebhookEndpoint(async (event) => ok(await doTheThing()));
//
// The token is read from `?token=` (what the main app sends) or `Authorization: Bearer` (what
// @civitai/moderation sends), so either convention works against the same endpoint.
//
// The token is VERIFIED in hooks.server.ts, not here: the hook can check it without knowing which
// endpoint the request is for, and an invalid token is refused before any handler runs. This wrapper
// asserts the hook's verdict, which is what makes an endpoint token-callable — an unwrapped endpoint
// refuses a token even when the token is valid.
//
// There is NO USER behind the token. `locals.user` is deliberately never populated here, so anything
// reached this way cannot attribute a write — which is what keeps `human_judgement` human-only.
//
// TWO CREDENTIALS ARE ACCEPTED, and the difference is reach, not privilege — inside this app they
// authorise exactly the same thing:
//
//   MOD_INBOUND_TOKEN — inbound-only, and the one to hand out. It appears NOWHERE else: no outbound
//     caller reads it and the main app does not know it, so a holder can reach this app and nothing
//     beyond it. A service that only ever calls IN should hold this and only this.
//   WEBHOOK_TOKEN  — kept accepted for COMPATIBILITY, because this app is on BOTH ends of it. The main
//     app presents it when it calls in, and four services here present it when they call out
//     (user-actions.service.ts, search-index.ts, kono.ts, training-moderation.service.ts) — see
//     .env.example, which requires it to match the main app's. One variable, two directions, so its
//     value is not ours to change independently: that is why the fix is a second accepted token and
//     not a rotation.
//
// So this is a MIGRATION SEAM, not a permission model. Move each inbound caller to MOD_INBOUND_TOKEN,
// and once none present WEBHOOK_TOKEN inbound, drop it from `acceptedTokens` — the outbound callers
// keep using it and are unaffected. Scoping a token to particular endpoints is a separate, later
// change: `EndpointAuth` is already `{kind:'webhook'} | {kind:'session'; page}` (api-endpoint.ts),
// so `{kind:'webhook'; scope}` has somewhere to go.

function presentedToken(event: { url: URL; request: Request }): Buffer {
  const query = event.url.searchParams.get('token');
  if (query) return Buffer.from(query.trim());
  const header = (event.request.headers.get('authorization') ?? '').trim();
  const scheme = header.slice(0, 7).toLowerCase();
  return Buffer.from(scheme === 'bearer ' ? header.slice(7).trim() : '');
}

/**
 * The credentials this deployment accepts inbound, as comparable buffers.
 *
 * Trimmed to match what a caller sends: a secret injected with a trailing newline would otherwise
 * differ in length from the byte-identical token a caller presents, and every request would 401
 * blaming the caller.
 *
 * 🔴 EMPTY IS NOT CONFIGURED. A variable that is set but blank is dropped rather than accepted, so a
 * caller presenting `?token=` with no value cannot match it — without this filter, blanking the
 * secret would turn every wrapped endpoint into an open one, which is the opposite of the
 * fail-closed behaviour the 503 below exists to provide.
 */
function acceptedTokens(): Buffer[] {
  return [env.MOD_INBOUND_TOKEN, env.WEBHOOK_TOKEN]
    .map((value) => (value ?? '').trim())
    .filter((value) => value.length > 0)
    .map((value) => Buffer.from(value));
}

/**
 * Called from hooks.server.ts for every `/api/*` request.
 *
 * `'none'` — no credential presented; fall through to the session guard.
 * `Response` — a credential was presented and refused; answer with it. Returned rather than thrown so a
 *   script gets JSON: an `error()` from the hook renders the HTML error page.
 * `'webhook'` — verified.
 */
export function authenticateWebhookToken(event: {
  url: URL;
  request: Request;
}): 'none' | Response | 'webhook' {
  if (!event.url.searchParams.has('token') && !event.request.headers.has('authorization'))
    return 'none';

  const accepted = acceptedTokens();
  // Fails CLOSED — with NO secret configured every wrapped endpoint is unreachable rather than
  // unguarded. 503 rather than 401 so an operator reading logs sees a deployment problem, not a caller
  // with a bad token. Either variable alone is a complete configuration: WEBHOOK_TOKEN alone is the
  // state before migration, MOD_INBOUND_TOKEN alone the state after.
  if (accepted.length === 0)
    return Response.json(
      { message: 'Neither MOD_INBOUND_TOKEN nor WEBHOOK_TOKEN is configured on this deployment.' },
      { status: 503 }
    );

  const provided = presentedToken(event);
  // Every candidate is compared, with no early exit on a match, so the time taken does not reveal WHICH
  // credential was presented or how many are configured. Length is checked first because
  // timingSafeEqual THROWS on a length mismatch; that leaks only the length, not the secret.
  let matched = false;
  for (const secret of accepted)
    if (provided.length === secret.length && timingSafeEqual(provided, secret)) matched = true;

  if (!matched)
    return Response.json(
      { message: 'Send a valid service token as `?token=` or `Authorization: Bearer <token>`.' },
      { status: 401 }
    );

  return 'webhook';
}

// Generic over the event so a route's own `RequestHandler` type survives the wrap — otherwise `params`
// widens to `Partial<Record<string, string>>` and every `params.id` becomes possibly-undefined.
export function WebhookEndpoint<E extends RequestEvent, R>(
  handler: (event: E) => R
): (event: E) => R {
  return (event) => {
    // The hook already verified the token; this is the opt-in that makes THIS endpoint token-callable.
    // A signed-in moderator hitting it is refused too — like the main app's WebhookEndpoint, these are
    // service endpoints, and there is no user behind one.
    if (event.locals.tokenClient !== 'webhook')
      error(401, 'Send a valid service token as `?token=` or `Authorization: Bearer <token>`.');
    return handler(event);
  };
}
