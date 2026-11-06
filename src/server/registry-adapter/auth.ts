/**
 * The auth extension (civitai-registry `spec/extensions/auth.md` @ 4166f34), as an ORIGIN serves
 * it, for both bindings:
 *
 *   - The token arrives in request metadata only: `Authorization: Bearer {token}` over HTTP, the
 *     `authorization` metadata key over gRPC. Never in the URL or the request's fields.
 *   - No token is anonymous: what anyone may read ({@link ANONYMOUS_PRINCIPAL}).
 *   - A token is verified by the site's own mechanism ({@link VerifyToken}; `auth.live.ts` wires
 *     it). Anything it does not accept, an expired token included, is `invalid_token`.
 *   - Each subscription is streamed what its token may read (`audience.ts`), and its cursor is
 *     tied to the token's subject (`subscription.ts`) and, for a document stream, to its audience
 *     (`doc-feed.ts`).
 *   - A stream never outlives its token: {@link watchPrincipal} ends it with `invalid_token` at
 *     the token's expiry, or when a re-check finds it no longer active.
 *
 * This source requires no scope, so it never sends `insufficient_scope`.
 */
import type { Audience } from '~/server/registry-adapter/audience';
import { ANONYMOUS_AUDIENCE, audienceForUser } from '~/server/registry-adapter/audience';
import type { ErrorCode } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/** A token the site accepted. */
export type VerifiedToken = {
  /** Stable for the token's user and client, across token refreshes. */
  subject: string;
  /** The user's browsing settings, which set the token's {@link Audience}. */
  user: { showNsfw?: boolean | null; browsingLevel?: number | null };
  expiresAt: Date | null;
};

/** The site's verification of a bearer token: null for one it does not accept. */
export type VerifyToken = (token: string) => Promise<VerifiedToken | null>;

export type Principal = {
  /** null: anonymous. */
  subject: string | null;
  audience: Audience;
  expiresAt: Date | null;
  /** Whether the token is still active; null for anonymous. */
  recheck: (() => Promise<boolean>) | null;
};

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
 */
export async function authenticate(
  authorization: string | undefined,
  verify: VerifyToken | undefined,
  now: () => number = Date.now
): Promise<Principal> {
  if (authorization === undefined || authorization === '') return ANONYMOUS_PRINCIPAL;
  const token = BEARER_RE.exec(authorization)?.[1];
  if (!token) throw invalidToken('the authorization is not a Bearer token');
  if (!verify) throw invalidToken('this source accepts no tokens');
  const verified = await verify(token);
  if (!verified) throw invalidToken('the token is not active');
  if (expired(verified, now())) throw invalidToken('the token has expired');
  return {
    subject: verified.subject,
    audience: audienceForUser(verified.user),
    expiresAt: verified.expiresAt,
    recheck: async () => {
      const again = await verify(token);
      return again !== null && again.subject === verified.subject && !expired(again, now());
    },
  };
}

/** How often an open stream's token is re-verified. */
export const TOKEN_RECHECK_MS = 5 * 60 * 1000;
/** The longest delay `setTimeout` takes; a later expiry is re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Calls `onInvalid` once, with `invalid_token`, when `principal`'s token expires or a re-check
 * finds it no longer active. A re-check that fails (the database unreachable) is not a finding
 * and ends nothing. Returns the function that stops watching; anonymous is never ended.
 */
export function watchPrincipal(
  principal: Principal,
  onInvalid: (err: ProtocolError) => void,
  opts: { recheckMs?: number; now?: () => number } = {}
): () => void {
  if (principal.subject === null) return () => undefined;
  const now = opts.now ?? Date.now;
  let done = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    done = true;
    clearTimeout(expiry);
    clearInterval(recheck);
  };
  const fire = (why: string) => {
    if (done) return;
    stop();
    onInvalid(invalidToken(why));
  };
  const armExpiry = () => {
    if (principal.expiresAt === null) return;
    const left = principal.expiresAt.getTime() - now();
    if (left <= 0) return fire('the token has expired');
    expiry = setTimeout(armExpiry, Math.min(left, MAX_TIMER_MS));
  };
  const recheck = setInterval(() => {
    principal.recheck?.().then(
      (active) => {
        if (!active) fire('the token is no longer active');
      },
      () => undefined
    );
  }, opts.recheckMs ?? TOKEN_RECHECK_MS);
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
