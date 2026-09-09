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
// ONE CREDENTIAL IS ACCEPTED INBOUND: MOD_INBOUND_TOKEN. It is inbound-only — this app never presents
// it outbound — which is what lets a service that only calls IN hold something narrower than the
// shared token it used to need.
//
// 🔴 WEBHOOK_TOKEN IS NO LONGER ACCEPTED INBOUND, AND IS STILL REQUIRED. Those are two different
// facts and collapsing them breaks this app. It was dropped from `acceptedTokens` once the runtime
// signal below showed no caller presenting it inbound. It remains SET, and four services here present
// it OUTBOUND to the main app (kono.ts, search-index.ts, training-moderation.service.ts,
// user-actions.service.ts) — two of which degrade by WARNING rather than failing, so unsetting the
// variable goes QUIET rather than loud. Do not "finish the migration" by removing it.
//
// 🔴 HOW THAT REMOVAL WAS GRADED — recorded because the same standard applies to the next one, and
// because the obvious shortcut is wrong. Every token-authenticated request logs which credential class
// matched (`webhook credential presented`, emitted from hooks.server.ts). The verdict needs BOTH
// numbers over one window: a ZERO for the retiring class is evidence only beside a NON-ZERO count for
// a live one in the SAME window, which is the in-band positive control proving the emit path was live
// and ingesting at the moment the zero was read. Without the pair, "nobody presents it any more" and
// "the log line never shipped, or stopped being ingested" are the identical observation. That is why
// the emit covers EVERY class rather than just a retiring one.
//
// 🔴 AND THE WINDOW MUST HAVE EXERCISED THE CALLERS. A window in which some inbound path never ran
// carries no evidence about that path — no calls and no legacy credential look the same from the
// count. The removal waited for a window in which every inbound caller had actually called, including
// the main app's own delegated moderation actions, which are human-driven and can be quiet for hours.
//
// Scoping a token to particular endpoints is a separate, later change: `EndpointAuth` is already
// `{kind:'webhook'} | {kind:'session'; page}` (api-endpoint.ts), so `{kind:'webhook'; scope}` has
// somewhere to go. 🔴 If that ever adds a SECOND accepted class, re-arm the no-early-exit guard in
// `__tests__/webhook-endpoint-timing.test.ts` — it is DORMANT at one credential and says so in place.
//
// Operational rationale for the split lives in the private infra repo, not here.

/**
 * The 401 body, shared by the hook and by both endpoint wrappers. One constant because all three
 * must say the same thing: this PR had to edit the literal in three places, which is the tell.
 *
 * Deliberately does NOT name a variable. Which credentials a deployment accepts is a deployment
 * detail, and the caller does not need it to fix a bad token.
 */
export const SEND_A_TOKEN =
  'Send a valid service token as `?token=` or `Authorization: Bearer <token>`.';

function presentedToken(event: { url: URL; request: Request }): Buffer {
  const query = event.url.searchParams.get('token');
  if (query) return Buffer.from(query.trim());
  const header = (event.request.headers.get('authorization') ?? '').trim();
  const scheme = header.slice(0, 7).toLowerCase();
  return Buffer.from(scheme === 'bearer ' ? header.slice(7).trim() : '');
}

/**
 * The credential VARIABLE NAMES this app accepts inbound, in PREFERENCE-DESCENDING order — most
 * preferred first, most legacy last.
 *
 * 🔴 ONE ENTRY TODAY, and two properties of this list are dormant rather than gone. Keep the ordering
 * rule if a second class is ever added: it decides which name the attribution record carries when a
 * deployment sets two variables to the SAME value (the match loop below is last-match-wins, so an
 * ambiguous deployment attributes to the most LEGACY class — which can only ever overstate legacy use,
 * never understate it), and it is the order the 503 body lists them in.
 *
 * A credential class is a variable NAME, never a value. Nothing derived from a token's bytes — not a
 * prefix, a length, or a hash — may leave this module.
 */
export const ACCEPTED_CREDENTIALS = ['MOD_INBOUND_TOKEN'] as const;

export type AcceptedCredential = (typeof ACCEPTED_CREDENTIALS)[number];

/** One accepted credential: the class that identifies it, and the bytes to compare against. */
type AcceptedToken = { credential: AcceptedCredential; secret: Buffer };

/**
 * The credentials this deployment accepts inbound, as comparable buffers LABELLED with the class they
 * came from. The label is what makes the migration checkable at runtime — see the header.
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
function acceptedTokens(): AcceptedToken[] {
  // Read by literal property rather than `env[credential]`: `$env/dynamic/private` is the deployment
  // surface, and a literal keeps each variable greppable from the manifests that inject it. The
  // Record type is what forces this map to grow when ACCEPTED_CREDENTIALS does — adding a name there
  // and forgetting to read it here is a type error, not a credential that silently never matches.
  const values: Record<AcceptedCredential, string | undefined> = {
    MOD_INBOUND_TOKEN: env.MOD_INBOUND_TOKEN,
  };
  return ACCEPTED_CREDENTIALS.map((credential) => ({
    credential,
    value: (values[credential] ?? '').trim(),
  }))
    .filter(({ value }) => value.length > 0)
    .map(({ credential, value }) => ({ credential, secret: Buffer.from(value) }));
}

/**
 * The verdict `authenticateWebhookToken` produces, tagged with an explicit `kind`.
 *
 * 🔴 The tag is the point. A `Response` is an object, so discriminating a union that carries one by
 * `instanceof` or `typeof x === 'object'` is a foot-gun the moment another object-shaped member is
 * added; every caller must branch on `kind` and nothing else.
 *
 * `none`          — no credential presented; fall through to the session guard.
 * `refused`       — a credential was presented and refused; answer with `response`. Returned rather than
 *                   thrown so a script gets JSON: an `error()` from the hook renders the HTML error page.
 * `authenticated` — verified, and `credential` names WHICH class matched.
 */
export type WebhookAuthResult =
  | { kind: 'none' }
  | { kind: 'refused'; response: Response }
  | { kind: 'authenticated'; credential: AcceptedCredential };

/** Called from hooks.server.ts for every `/api/*` request. */
export function authenticateWebhookToken(event: { url: URL; request: Request }): WebhookAuthResult {
  if (!event.url.searchParams.has('token') && !event.request.headers.has('authorization'))
    return { kind: 'none' };

  const accepted = acceptedTokens();
  // Fails CLOSED — with NO secret configured every wrapped endpoint is unreachable rather than
  // unguarded. 503 rather than 401 so an operator reading logs sees a deployment problem, not a caller
  // with a bad token. MOD_INBOUND_TOKEN is now the ONLY accepted inbound class, so it is also the only
  // complete configuration; the legacy class was dropped once the runtime signal showed no caller
  // presenting it (see the header). The body names every accepted class, derived from the list itself
  // so the two cannot drift.
  if (accepted.length === 0) {
    // Phrased for EITHER list length: "Neither A nor B" is ungrammatical with one name, and this list
    // is one name today. Keeping it derived rather than hardcoded is what stops the body drifting from
    // the accepted set when a second class is added back.
    const names = ACCEPTED_CREDENTIALS.join(' nor ');
    const message =
      ACCEPTED_CREDENTIALS.length > 1
        ? `Neither ${names} is configured on this deployment.`
        : `${names} is not configured on this deployment.`;
    return {
      kind: 'refused',
      response: Response.json({ message }, { status: 503 }),
    };
  }

  const provided = presentedToken(event);
  // Every candidate is compared with no early exit on a match, so WHICH credential matched is not
  // revealed by how long the comparison takes. (It does not hide how many candidates share the
  // presented token's LENGTH — that is not a property being claimed here.) Length is checked first
  // because timingSafeEqual THROWS on a length mismatch; that leaks only the length, not the secret.
  //
  // 🔴 Recording WHICH candidate matched must not reintroduce that signal: this is the same single
  // assignment the boolean flag used to be, in the same branch, with no `break` and no `else`. Do not
  // add either.
  //
  // No `else` also means LAST MATCH WINS, and ACCEPTED_CREDENTIALS is preference-DESCENDING — so a
  // deployment holding the same value in both variables attributes to the LAST, i.e. the most legacy,
  // class. Deliberate: one shared value is indistinguishable on the wire, and attributing it to the
  // legacy credential can only OVERSTATE legacy use. A migration proof that errs toward "still in
  // use" is safe; one that errs toward zero is the failure this signal exists to prevent.
  let matched: AcceptedCredential | null = null;
  for (const candidate of accepted)
    if (provided.length === candidate.secret.length && timingSafeEqual(provided, candidate.secret))
      matched = candidate.credential;

  if (matched === null)
    return { kind: 'refused', response: Response.json({ message: SEND_A_TOKEN }, { status: 401 }) };

  return { kind: 'authenticated', credential: matched };
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
    if (event.locals.tokenClient !== 'webhook') error(401, SEND_A_TOKEN);
    return handler(event);
  };
}
