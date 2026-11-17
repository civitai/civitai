/**
 * The auth hub's exchanged access tokens, as this source verifies them.
 *
 * A relay in front of this source exchanges each consumer's token at the hub (RFC 8693) for one
 * whose resource is this source, and sends that: an RFC 9068 JWT access token (`typ: at+jwt`),
 * ES256-signed with the hub's key. As RFC 9068 §4 asks of a resource server (with the resource
 * indicator of RFC 8707 as the token's `aud`): accept only tokens issued for this source, and any
 * other token is `invalid_token`.
 *
 * Which path a bearer takes is decided by its shape alone ({@link isAccessTokenJwt}): a JWS whose
 * header says `typ: at+jwt` is verified here and nowhere else, so one that fails is
 * `invalid_token` and never reaches the opaque (database) lookup; every other bearer goes to the
 * opaque path, unchanged.
 *
 * A verified token stands for the same subject the opaque path gives the same user and client
 * (`user:{id}/client:{clientId}`), so cursors and per-token caps treat both alike, and its user is
 * read and refused the same way (`getBearerTokenUser`).
 */
import { createAccessTokenJwtVerifier, isAccessTokenJwt } from '@civitai/auth';
import { ALL_SCOPES, TokenScope } from '~/shared/constants/token-scope.constants';
import type { VerifiedToken, VerifyToken } from '~/server/registry-adapter/auth';

/** The hub's issuer identifier, when none is configured. */
export const DEFAULT_HUB_ISSUER = 'https://auth.civitai.com';

/**
 * The token's scope names as the site's bitmask. A name the site does not know counts as every
 * scope, and so does a missing or non-string `scope` claim, so a check that refuses write scopes
 * (a system account's) refuses it rather than missing it.
 */
export function scopeBits(scope: unknown): bigint {
  if (typeof scope !== 'string') return ALL_SCOPES;
  let bits = 0n;
  for (const name of scope.split(' ').filter(Boolean)) {
    // `None` is 0 in the bitmask: looked up, a token claiming only `None` would read as no scope
    // at all, so it is treated like an unknown name instead.
    if (name !== 'None' && Object.hasOwn(TokenScope, name)) {
      bits |= TokenScope[name as keyof typeof TokenScope];
    } else {
      bits |= ALL_SCOPES;
    }
  }
  return bits;
}

export type HubJwtConfig = {
  /** The hub's issuer identifier; `iss` must equal it exactly. */
  issuer: string;
  /** Where the hub publishes its signing keys. */
  jwksUri: string;
  /**
   * This source's resource identifier; `aud` must name it exactly. Unset: this source has no
   * resource identifier, no token can have been issued for it, and every JWT is refused.
   */
  audience: string | undefined;
};

export type HubJwtDeps = {
  /** The user a bearer for `userId` with `tokenScope` acts as, or null (`getBearerTokenUser`). */
  loadUser: (userId: number, tokenScope: bigint) => Promise<VerifiedToken['user'] | null>;
};

const USER_ID_RE = /^[1-9][0-9]{0,15}$/;

/**
 * Verifies a hub access token for this source: signature against the hub's JWKS (cached, refetched
 * on an unknown `kid`), ES256 only, `typ: at+jwt`, `iss` and `aud` exactly, `exp`/`nbf` with no
 * leeway, then the user. Null for a token that fails any check; throws when the hub's keys cannot
 * be read, so a re-check during a hub outage is not taken for a revocation.
 *
 * Exchanged tokens are checked locally, never introspected at the hub: the signature, `iss`,
 * `aud` and `exp` here, and the user's ban/delete state (`loadUser`) on every re-check. Revoking
 * the subject token or the consent, disabling the app, or delisting the relay at the hub reaches a
 * live stream only when the exchanged token expires (the hub caps exchanged tokens at 15 minutes).
 */
export function createHubJwtVerifier(config: HubJwtConfig, deps: HubJwtDeps): VerifyToken {
  const { audience } = config;
  if (!audience) return async () => null;
  const verifyJwt = createAccessTokenJwtVerifier({
    jwksUri: config.jwksUri,
    audience,
  });
  return async (token) => {
    const payload = await verifyJwt(token, config.issuer);
    if (!payload) return null;
    const { sub, client_id: clientId, exp } = payload as typeof payload & { client_id?: unknown };
    if (typeof sub !== 'string' || !USER_ID_RE.test(sub)) return null;
    if (typeof clientId !== 'string' || clientId === '') return null;
    if (typeof exp !== 'number') return null;
    const userId = Number(sub);
    const user = await deps.loadUser(userId, scopeBits(payload.scope));
    if (!user) return null;
    return {
      subject: `user:${userId}/client:${clientId}`,
      user,
      expiresAt: new Date(exp * 1000),
    };
  };
}

/**
 * One {@link VerifyToken} over both kinds of bearer: a hub access token goes to `jwt` and only
 * there; anything else goes to `opaque`.
 */
export function routeVerifyToken({
  opaque,
  jwt,
}: {
  opaque: VerifyToken;
  jwt: VerifyToken;
}): VerifyToken {
  return (token) => (isAccessTokenJwt(token) ? jwt(token) : opaque(token));
}
