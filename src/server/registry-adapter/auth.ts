/**
 * The registry spec's auth extension, as an ORIGIN serves
 * it, for both bindings:
 *
 *   - The token arrives in request metadata only: `Authorization: Bearer {token}` over HTTP, the
 *     `authorization` metadata key over gRPC. Never in the URL or the request's fields.
 *   - No token is anonymous: what anyone may read ({@link ANONYMOUS_PRINCIPAL}).
 *   - A token is verified by the site's own mechanism ({@link VerifyToken}; `auth.live.ts` wires
 *     it). Anything it does not accept, an expired token included, is `invalid_token`.
 *   - Each subscription is streamed what its token may read (`audience.ts`), held to the SFW
 *     rule from a region the site restricts to SFW content, and its cursor is
 *     tied to the token's subject (`subscription.ts`) and, for a document, app, release or
 *     schema stream, to its audience (`doc-feed.ts`, `cursor.ts`).
 *   - A service token (a client acting as itself, no user; `auth.jwt.ts`) is accepted only for a
 *     client on this source's service allowlist, and reads {@link SERVICE_AUDIENCE}: every
 *     rating, with no region hold. The allowlist is empty unless configured, so by default every
 *     service token is `invalid_token`, as a token with no user always was.
 *   - A stream never outlives its token: {@link watchPrincipal} ends it with `invalid_token` at
 *     the token's expiry, or when a re-check finds it no longer active; and a re-check that
 *     finds the user may now read different ratings ends it with `cursor_expired`, so the
 *     consumer re-snapshots under them.
 *
 * No stream requires a scope yet, so this source never sends `insufficient_scope`; a verified
 * token carries its scope ({@link VerifiedToken.scope}) for the check that will
 * (`hasScope` in `auth.jwt.ts`).
 */
import type { Audience } from '~/server/registry-adapter/audience';
import {
  ANONYMOUS_AUDIENCE,
  SERVICE_AUDIENCE,
  audienceForUser,
} from '~/server/registry-adapter/audience';
import type { ErrorCode } from '~/server/registry-adapter/protocol';
import { ProtocolError, cursorExpired } from '~/server/registry-adapter/protocol';

type VerifiedTokenBase = {
  /** Stable for the token's user (or service) and client, across token refreshes. */
  subject: string;
  /** The OAuth client the token was issued to (the JWT's `client_id`). */
  clientId: string;
  /**
   * The scopes the token GRANTS, as the site's bitmask: a name the site does not know grants
   * nothing (`scopeGrantBits` in `auth.jwt.ts`). Read it with `hasScope`.
   */
  scope: bigint;
  /** Who presents the token on the client's behalf (the JWT's `act.sub`); null when no one does. */
  actor: string | null;
  expiresAt: Date | null;
};

/** The user's browsing settings, which set a user token's {@link Audience}. */
export type TokenUser = { showNsfw?: boolean | null; browsingLevel?: number | null };

/** A token the site accepted: a user's, or an allowlisted service's (`service: true`). */
export type VerifiedToken =
  | (VerifiedTokenBase & {
      service?: undefined;
      user: TokenUser;
    })
  | (VerifiedTokenBase & {
      /**
       * A client acting as itself, with no user, whose client is on this source's service
       * allowlist (`auth.jwt.ts`). Its audience is {@link SERVICE_AUDIENCE}.
       */
      service: true;
      user?: undefined;
    });

/** The site's verification of a bearer token: null for one it does not accept. */
export type VerifyToken = (token: string) => Promise<VerifiedToken | null>;

export type Principal = {
  /** null: anonymous. */
  subject: string | null;
  /** Set for an allowlisted service token: its audience is {@link SERVICE_AUDIENCE}. */
  service?: true;
  /** The token's OAuth client (`client_id`), and who presented it for that client (`act.sub`). */
  clientId?: string;
  actor?: string | null;
  audience: Audience;
  expiresAt: Date | null;
  /** Re-verifies the token now; null for anonymous. */
  recheck: (() => Promise<Recheck>) | null;
};

/**
 * What a re-check found: the token still active with the same readable ratings, no longer
 * active, or active with a different {@link Audience} (the user changed their browsing settings).
 */
export type Recheck = 'active' | 'inactive' | 'audience-changed';

export const ANONYMOUS_PRINCIPAL: Principal = {
  subject: null,
  audience: ANONYMOUS_AUDIENCE,
  expiresAt: null,
  recheck: null,
};

const BEARER_RE = /^Bearer[ ]+([^\s]+)[ ]*$/i;

export const invalidToken = (why: string) => new ProtocolError('invalid_token', why);

const expired = (token: VerifiedToken, now: number) =>
  token.expiresAt !== null && token.expiresAt.getTime() <= now;

/**
 * The principal of a request whose `Authorization` value (HTTP header or gRPC metadata) is
 * `authorization`. Without `verify`, this source accepts no token, so any token is
 * `invalid_token`.
 *
 * `regionRestricted` says whether the request is held to SFW content: from a region the site
 * restricts or blocks, or with no region at all (`request-origin.ts`); its audience is then the
 * SFW one (`audienceForUser`). It is required, so every caller decides it. It is
 * asked again at each re-check, with the same answer for the same request until a restriction's
 * effective date passes, so a re-check compares like with like and a restriction that starts
 * mid-stream ends the stream with `cursor_expired`. A service token is never held to it: its
 * audience is {@link SERVICE_AUDIENCE} wherever the request comes from.
 */
export async function authenticate(
  authorization: string | undefined,
  verify: VerifyToken | undefined,
  { now = Date.now, regionRestricted }: { now?: () => number; regionRestricted: () => boolean }
): Promise<Principal> {
  if (authorization === undefined || authorization === '') return ANONYMOUS_PRINCIPAL;
  const token = BEARER_RE.exec(authorization)?.[1];
  if (!token) throw invalidToken('the authorization is not a Bearer token');
  if (!verify) throw invalidToken('this source accepts no tokens');
  const verified = await verify(token);
  if (!verified) throw invalidToken('the token is not active');
  if (expired(verified, now())) throw invalidToken('the token has expired');
  const audienceOf = (v: VerifiedToken) =>
    v.service === true
      ? SERVICE_AUDIENCE
      : audienceForUser(v.user, { regionRestricted: regionRestricted() });
  const audience = audienceOf(verified);
  return {
    subject: verified.subject,
    ...(verified.service === true ? { service: true as const } : {}),
    clientId: verified.clientId,
    actor: verified.actor,
    audience,
    expiresAt: verified.expiresAt,
    recheck: async () => {
      const again = await verify(token);
      if (again === null || again.subject !== verified.subject || expired(again, now())) {
        return 'inactive';
      }
      return audienceOf(again).key === audience.key ? 'active' : 'audience-changed';
    },
  };
}

/**
 * How often an open stream's token is re-verified, on average: each wait is drawn from ±20% of
 * it, so streams opened in a burst do not re-check the database in a burst.
 *
 * Each open stream re-checks its own token, uncached on purpose: the re-check is what notices a
 * revocation, a ban or a changed browsing setting, and a per-token cache would have to stay
 * shorter than this interval to keep that bound, so it saves little and adds a second place for
 * staleness to hide.
 */
export const TOKEN_RECHECK_MS = 5 * 60 * 1000;
const RECHECK_JITTER = 0.2;
/** The longest delay `setTimeout` takes; a later expiry is re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Calls `onEnd` once, to end `principal`'s stream:
 *   - `invalid_token` when the token expires or a re-check finds it no longer active;
 *   - `cursor_expired` when a re-check finds the user may now read different ratings (they
 *     changed their browsing settings), so the consumer starts over without a cursor and is sent
 *     a snapshot under the new ratings. The stream's audience is fixed for its life (its cursors
 *     name it), so ending it is the only way to apply the change, lowered or raised.
 * A re-check that fails (the database unreachable) is not a finding and ends nothing. Returns the
 * function that stops watching; anonymous is never ended.
 */
export function watchPrincipal(
  principal: Principal,
  onEnd: (err: ProtocolError) => void,
  opts: { recheckMs?: number; now?: () => number; random?: () => number } = {}
): () => void {
  if (principal.subject === null) return () => undefined;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const every = opts.recheckMs ?? TOKEN_RECHECK_MS;
  let done = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    done = true;
    clearTimeout(expiry);
    clearTimeout(recheck);
  };
  const end = (err: ProtocolError) => {
    if (done) return;
    stop();
    onEnd(err);
  };
  const fire = (why: string) => end(invalidToken(why));
  const armExpiry = () => {
    if (principal.expiresAt === null) return;
    const left = principal.expiresAt.getTime() - now();
    if (left <= 0) return fire('the token has expired');
    expiry = setTimeout(armExpiry, Math.min(left, MAX_TIMER_MS));
  };
  const armRecheck = () => {
    const wait = every * (1 - RECHECK_JITTER + 2 * RECHECK_JITTER * random());
    recheck = setTimeout(() => {
      if (done || !principal.recheck) return;
      principal.recheck().then(
        (found) => {
          if (found === 'inactive') fire('the token is no longer active');
          else if (found === 'audience-changed') {
            end(cursorExpired('the ratings this token may read changed; start over'));
          } else if (!done) armRecheck();
        },
        () => {
          if (!done) armRecheck();
        }
      );
    }, wait);
  };
  armRecheck();
  armExpiry();
  return stop;
}

/** The `WWW-Authenticate` value of an auth error sent before a stream starts (RFC 6750, RFC 9728). */
export function wwwAuthenticate(
  code: ErrorCode,
  message: string,
  resourceMetadataUrl?: string
): string {
  const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;
  const params = [`error=${quote(code)}`, `error_description=${quote(message)}`];
  if (resourceMetadataUrl) params.push(`resource_metadata=${quote(resourceMetadataUrl)}`);
  return `Bearer ${params.join(', ')}`;
}

export const isAuthError = (code: ErrorCode) =>
  code === 'invalid_token' || code === 'insufficient_scope';

/** Where a resource server publishes its protected resource metadata (RFC 9728). */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/** What the auth extension needs configured to be advertised. */
export type ResourceConfig = {
  /** This source's resource identifier: its public URL. */
  resource: string;
  /** The issuers whose tokens it accepts. */
  issuers: string[];
};

export function protectedResourceMetadata(config: ResourceConfig) {
  return {
    resource: config.resource,
    authorization_servers: config.issuers,
    bearer_methods_supported: ['header'],
  };
}

export const resourceMetadataUrl = (config: ResourceConfig | undefined) =>
  config ? `${config.resource.replace(/\/$/, '')}${PROTECTED_RESOURCE_PATH}` : undefined;
