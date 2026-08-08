import { timingSafeEqual } from 'node:crypto';
import { error, type RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// WEBHOOK ENDPOINTS — the spoke's equivalent of the main app's WebhookEndpoint
// (src/server/utils/endpoint-helpers.ts). Wrap any `/api/*` handler to make it callable by a service
// holding the shared WEBHOOK_TOKEN instead of by a signed-in moderator:
//
//   export const POST = WebhookEndpoint(async (event) => ok(await doTheThing()));
//
// The token is read from `?token=` (what the main app sends) or `Authorization: Bearer` (what
// @civitai/moderation sends), so either convention works against the same endpoint.
//
// The token is VERIFIED in hooks.server.ts, not here: there is one secret, so the hook can check it
// without knowing which endpoint the request is for, and an invalid token is refused before any handler
// runs. This wrapper asserts the hook's verdict, which is what makes an endpoint token-callable —
// an unwrapped endpoint refuses a token even when the token is valid.
//
// There is NO USER behind the token. `locals.user` is deliberately never populated here, so anything
// reached this way cannot attribute a write — which is what keeps `human_judgement` human-only.

function presentedToken(event: { url: URL; request: Request }): Buffer {
  const query = event.url.searchParams.get('token');
  if (query) return Buffer.from(query.trim());
  const header = (event.request.headers.get('authorization') ?? '').trim();
  const scheme = header.slice(0, 7).toLowerCase();
  return Buffer.from(scheme === 'bearer ' ? header.slice(7).trim() : '');
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

  const expected = env.WEBHOOK_TOKEN;
  // Fails CLOSED — an unset secret makes every wrapped endpoint unreachable rather than unguarded. 503
  // rather than 401 so an operator reading logs sees a deployment problem, not a caller with a bad token.
  if (!expected)
    return Response.json(
      { message: 'WEBHOOK_TOKEN is not configured on this deployment.' },
      { status: 503 }
    );

  const provided = presentedToken(event);
  // Trimmed to match: a secret injected with a trailing newline would otherwise differ in length from the
  // byte-identical token a caller sends, and every request would 401 blaming the caller.
  const secret = Buffer.from(expected.trim());
  // Length first because timingSafeEqual throws on a mismatch; it leaks only the length, not the secret.
  if (provided.length !== secret.length || !timingSafeEqual(provided, secret))
    return Response.json(
      { message: 'Send WEBHOOK_TOKEN as `?token=` or `Authorization: Bearer <token>`.' },
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
      error(401, 'Send WEBHOOK_TOKEN as `?token=` or `Authorization: Bearer <token>`.');
    return handler(event);
  };
}
