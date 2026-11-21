import { json } from '@sveltejs/kit';
import { createHash, randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getRedis } from '$lib/server/redis';
import { logOAuthEvent } from './audit-log';
import { userHasRole } from './access';
import { appBlockSuspended } from './app-block-mint-lock';
import { authenticatedConfidentialClient, clientIdMismatch } from './client-auth';
import { ACCESS_TOKEN_TYPE, SYSTEM_WORKLOAD_ROLE } from './constants';
import { findExchangeResource } from './exchange-resources';
import { basicCredentials } from './http';
import {
  chargeTokenExchangeFailure,
  checkTokenExchangeRateLimit,
  oauthRetryAfter,
  rateLimitedResponse,
} from './rate-limit';
import { parseScopeRequest } from './scope';
import {
  EXCHANGED_TOKEN_MAX_TTL,
  findExchangeClient,
  mintExchangedJwt,
  scopeNames,
  userRefusal,
} from './token-exchange';
import { getSigner } from './user-exchange';
import { verifyBlockTokenForExchange } from './block-token-verify';

// RFC 8693 token exchange of an App Block token (the RS256 JWT the site signs for a block acting for a
// signed-in viewer) for the token the registry adapter's PRIVATE FEED accepts, in one hop: an RFC 9068
// `at+jwt` minted exactly as the user token exchange mints one (`mintExchangedJwt`):
//   - `sub` = the viewer, `client_id` = the block's app, `act.sub` = the relay that called;
//   - `aud` = the requested resource, `iss` = the hub;
//   - `scope` = exactly `AppDataRead`, whatever the block token carries;
//   - `exp` = min(the block token's `exp`, now + 15 minutes); no refresh token.
// The private feed opens only for a listed relay in `act.sub` (`privateTokenGate`), which is why this is a
// JWT and not an opaque token: an opaque token has no actor.
//
// DARK BY DEFAULT. Only a confidential client named in OAUTH_BLOCK_EXCHANGE_CALLERS may call it, and that list
// is empty unless set: empty (or invalid) refuses every request first. An entry is added only once the
// registry owner approves it.
//
// WHAT DECIDES ACCESS. The block token's `apps:storage` scope is required, but it is NOT the viewer's consent:
// `apps:storage` is consent-exempt and is signed into every signed-in viewer's token for any app that declares
// a collection. What decides whether a token is minted is: the caller is an allowlisted relay of the resource;
// the block's app is listed for the resource, enabled, not suspended, and holds AppDataRead in its
// `allowedScopes`; the viewer passes the user exchange's checks. What the token then reads is decided by the
// private feed, which re-runs `decideCollectionRead` on every poll: the app's own collections for this viewer,
// or another app's only through a grant the viewer made.
//
// Every outcome is an `oauth-audit` event (`block_exchange.issued` / `block_exchange.refused`) with the
// reason; the response carries only the standard error. No log line carries a token.
//
// REVOCATION. Nothing is stored that a revocation could delete, and the exchange reads no revocation state:
// the user revoking the app (`revokeApp`, `revokeOauthConsentForBlock`), withdrawing its permissions, or
// uninstalling the block (`BlockRevocation`, held in the site's cache Redis) does not stop a block token that
// is still valid from being exchanged, nor a token already minted. Each is bounded by `exp`: at most 15
// minutes after the block token was signed, since the token never outlives it. No signal in the hub's
// database means "this viewer revoked this app" for every block app: an `OauthConsent` row exists only for
// apps that mint OAuth tokens, and `app_user_scope_grants.revoked_at` covers consent-gated scopes (which
// `apps:storage` is not) and is also set to force a re-consent. The private feed's per-poll predicate still
// stops a revoked import grant and an unapproved app within one poll.

type ExchangeError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_target'
  | 'unauthorized_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'rate_limited'
  | 'server_error'
  | 'temporarily_unavailable';

const STATUS: Record<Exclude<ExchangeError, 'rate_limited'>, number> = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_target: 400,
  unauthorized_client: 400,
  invalid_grant: 400,
  invalid_scope: 400,
  server_error: 500,
  temporarily_unavailable: 503,
};

const DESCRIPTION: Record<ExchangeError, string> = {
  invalid_request: 'Invalid token exchange request',
  invalid_client: 'Client authentication failed',
  invalid_target: 'Unknown resource',
  unauthorized_client: 'This client may not exchange this token for this resource',
  invalid_grant: 'The subject token cannot be exchanged',
  invalid_scope: 'Invalid scope',
  rate_limited: 'Too many token requests',
  server_error: 'Internal error',
  temporarily_unavailable: 'Try again',
};

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** The one scope a minted token holds. */
export const BLOCK_EXCHANGE_SCOPE = TokenScope.AppDataRead;

/**
 * The block-token scope required to exchange: the app declares a document-store collection. Consent-exempt,
 * so it says nothing about the viewer's consent (see the file comment).
 */
export const STORAGE_SCOPE = 'apps:storage';

// ─── The caller allowlist ─────────────────────────────────────

const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * OAUTH_BLOCK_EXCHANGE_CALLERS: the confidential client ids that may call the block token exchange, separated
 * by commas or whitespace. Unset or empty is nobody. One malformed id empties the whole list (fail closed):
 * a typo never leaves a partial list in force unnoticed.
 */
export function parseBlockExchangeCallers(
  raw: string | undefined
): { callers: ReadonlySet<string> } | { error: string } {
  const ids = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  const bad = ids.find((id) => !CLIENT_ID.test(id));
  if (bad !== undefined) return { error: 'OAUTH_BLOCK_EXCHANGE_CALLERS has an invalid client id' };
  return { callers: new Set(ids) };
}

function blockExchangeCallers(): { callers: ReadonlySet<string>; invalid: boolean } {
  const parsed = parseBlockExchangeCallers(env.OAUTH_BLOCK_EXCHANGE_CALLERS);
  return 'error' in parsed
    ? { callers: new Set(), invalid: true }
    : { callers: parsed.callers, invalid: false };
}

// ─── Replay: a block token is exchanged once ──────────────────

type ReplayRedis = {
  set(key: string, value: string, opts: { NX: true; EX: number }): Promise<string | null>;
  del(key: string): Promise<unknown>;
};

const REPLAY_TIMEOUT_MS = 2000;

const replayKey = (jti: string) =>
  `auth:block-exchange:jti:${createHash('sha256').update(jti).digest('hex')}`;

async function withTimeout<T>(op: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('replay store timed out')), REPLAY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claim the block token's `jti` for one exchange. True when this request claimed it, false when an earlier
 * one did. Throws when the claim cannot be made (no Redis, an error, a timeout): the caller refuses, since an
 * unrecorded claim could be replayed.
 */
async function claimBlockTokenJti(jti: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis() as unknown as ReplayRedis | null;
  if (!redis) throw new Error('REDIS_URL is not configured');
  const reply = await withTimeout(
    redis.set(replayKey(jti), '1', { NX: true, EX: Math.max(1, ttlSeconds) })
  );
  return reply !== null;
}

/** Give a claimed `jti` back after a failed mint, so the caller's retry is not refused as a replay. */
async function releaseBlockTokenJti(jti: string): Promise<void> {
  const redis = getRedis() as unknown as ReplayRedis | null;
  if (!redis) return;
  await withTimeout(Promise.resolve(redis.del(replayKey(jti))));
}

// ─── The exchange ─────────────────────────────────────────────

export interface BlockExchangeInput {
  request: Request;
  body: Record<string, string>;
  /** Every `resource` value the request carried (a form can repeat it). */
  resources: string[];
  clientIp: string | null;
  /** Whether the body was form-encoded, as RFC 8693 requires. */
  formEncoded: boolean;
}

/** Handle a token exchange whose `subject_token_type` is a block token. */
export async function handleBlockTokenExchange(input: BlockExchangeInput): Promise<Response> {
  const { request, body } = input;
  // What the audit event carries, as far as each is known. Never a token.
  const ctx: {
    caller?: string;
    resource?: string;
    app?: string;
    appBlockId?: string;
    blockJti?: string;
    userId?: number;
  } = {};
  const ip = input.clientIp ?? 'unknown';

  const refuse = (error: ExchangeError, reason: string, extra?: HeadersInit) => {
    logOAuthEvent({
      type: 'block_exchange.refused',
      userId: ctx.userId,
      clientId: ctx.app,
      ip,
      metadata: {
        error,
        reason,
        caller: ctx.caller ?? null,
        resource: ctx.resource ?? null,
        appBlockId: ctx.appBlockId ?? null,
        blockJti: ctx.blockJti ?? null,
      },
    });
    const headers = new Headers(NO_STORE);
    for (const [k, v] of new Headers(extra)) headers.set(k, v);
    if (error === 'rate_limited') {
      return rateLimitedResponse(oauthRetryAfter('token-exchange'), headers, DESCRIPTION[error]);
    }
    return json(
      { error, error_description: DESCRIPTION[error] },
      { status: STATUS[error], headers }
    );
  };

  // Before the caller has authenticated, a refusal is charged to its IP (`token-exchange-ip`, the bucket the
  // user exchange charges failed client authentication to). Past that limit the answer is a 429 with NO
  // audit event, so an unauthenticated flood cannot drive the audit log's volume.
  const basicAttempted = /^basic /i.test(request.headers.get('authorization') ?? '');
  const refuseUnauthenticated = async (error: ExchangeError, reason: string) => {
    if (!(await chargeTokenExchangeFailure(input.clientIp))) {
      return rateLimitedResponse(
        oauthRetryAfter('token-exchange'),
        new Headers(NO_STORE),
        DESCRIPTION.rate_limited
      );
    }
    return refuse(
      error,
      reason,
      error === 'invalid_client' && basicAttempted
        ? { 'WWW-Authenticate': 'Basic realm="Service"' }
        : undefined
    );
  };

  let claimedJti: string | undefined;
  try {
    // 0. Dark unless a caller is listed: nothing else is read.
    const allow = blockExchangeCallers();
    if (allow.callers.size === 0) {
      return refuseUnauthenticated(
        'unauthorized_client',
        allow.invalid ? 'caller allowlist invalid' : 'caller allowlist empty'
      );
    }

    // 1. Parameters.
    if (!input.formEncoded) return refuseUnauthenticated('invalid_request', 'not form-encoded');
    const subjectToken = body.subject_token;
    if (typeof subjectToken !== 'string' || !subjectToken) {
      return refuseUnauthenticated('invalid_request', 'missing subject_token');
    }
    if (input.resources.length !== 1 || !input.resources[0]) {
      return refuseUnauthenticated('invalid_request', 'exactly one resource is required');
    }
    if (
      body.requested_token_type !== undefined &&
      body.requested_token_type !== ACCESS_TOKEN_TYPE
    ) {
      return refuseUnauthenticated('invalid_request', 'unsupported requested_token_type');
    }
    if (body.actor_token !== undefined || body.actor_token_type !== undefined) {
      return refuseUnauthenticated('invalid_request', 'actor_token is not supported');
    }
    if (body.scope !== undefined) {
      const requested = parseScopeRequest(body.scope);
      if (!requested || requested.openid || requested.scope !== BLOCK_EXCHANGE_SCOPE) {
        return refuseUnauthenticated('invalid_scope', 'scope must be AppDataRead');
      }
    }
    ctx.resource = input.resources[0];

    // 2. Client authentication, then the allowlist.
    if (clientIdMismatch(basicCredentials(request)?.id, body)) {
      return refuseUnauthenticated('invalid_client', 'client_id mismatch');
    }
    const caller = await authenticatedConfidentialClient(request, body);
    if (!caller) return refuseUnauthenticated('invalid_client', 'client authentication failed');
    ctx.caller = caller.id;
    if (!allow.callers.has(caller.id)) {
      return refuse('unauthorized_client', 'caller not allowlisted');
    }
    if (!(await checkTokenExchangeRateLimit(caller.id, caller.tokenRateLimit))) {
      return refuse('rate_limited', 'client limit');
    }
    if (caller.accessMode === 'disabled') return refuse('unauthorized_client', 'caller disabled');

    // 3. The resource, as the user exchange judges it.
    const resource = await findExchangeResource(ctx.resource);
    if (!resource) return refuse('invalid_target', 'resource not registered');
    if ((resource.scopes & BLOCK_EXCHANGE_SCOPE) === 0n) {
      return refuse('invalid_target', 'resource does not receive AppDataRead');
    }
    if (!resource.relays.includes(caller.id)) {
      return refuse('unauthorized_client', 'caller not a relay of resource');
    }

    // 4. The block token.
    const verified = await verifyBlockTokenForExchange(subjectToken);
    if (!verified.ok) {
      if (verified.reason === 'not configured' || verified.reason === 'misconfigured') {
        return refuse('server_error', `block token keys ${verified.reason}`);
      }
      return refuse('invalid_grant', `block token ${verified.reason}`);
    }
    const block = verified.token;
    ctx.app = block.appId;
    ctx.appBlockId = block.appBlockId;
    ctx.blockJti = block.jti;
    ctx.userId = block.userId;

    // 5. The app declares a document-store collection (consent-exempt: not the viewer's consent).
    if (!block.scopes.includes(STORAGE_SCOPE)) {
      return refuse('invalid_grant', 'block token has no apps:storage scope');
    }

    // 6. The block's app.
    if (!resource.apps.includes(block.appId)) {
      return refuse('unauthorized_client', 'app not listed for resource');
    }
    const app = await findExchangeClient(block.appId);
    if (!app) return refuse('invalid_grant', 'app not found');
    if (app.accessMode === 'disabled') return refuse('unauthorized_client', 'app disabled');
    if ((app.allowedScopes & BLOCK_EXCHANGE_SCOPE) === 0n) {
      return refuse('invalid_scope', 'app may not hold AppDataRead');
    }

    // 7. The viewer.
    const userProblem = await userRefusal(block.userId, BLOCK_EXCHANGE_SCOPE, app);
    if (userProblem) return refuse(userProblem.refusal, userProblem.reason);
    if (await userHasRole(block.userId, SYSTEM_WORKLOAD_ROLE)) {
      return refuse('invalid_grant', 'workload account');
    }

    // 8. The app's blocks, at mint time.
    if (await appBlockSuspended(db, block.appId)) {
      return refuse('unauthorized_client', 'app block suspended');
    }

    // 9. Issuer, key and lifetime: at most 15 minutes, never past the block token.
    const issuer = env.AUTH_JWT_ISSUER;
    const tokenSigner = getSigner();
    if (!issuer || !tokenSigner)
      return refuse('server_error', 'issuer or signing key not configured');
    const iat = Math.floor(Date.now() / 1000);
    const exp = Math.min(block.exp, iat + EXCHANGED_TOKEN_MAX_TTL);
    if (exp <= iat) return refuse('invalid_grant', 'block token expiring');

    // 10. Once per block token: claimed as the last step before minting, and given back if the mint fails,
    // so a failure the caller is told to retry does not burn the block token.
    let claimed: boolean;
    try {
      claimed = await claimBlockTokenJti(block.jti, block.exp - iat + 60);
    } catch (err) {
      return refuse('temporarily_unavailable', `replay check failed: ${String(err)}`, {
        'Retry-After': '5',
      });
    }
    if (!claimed) return refuse('invalid_grant', 'block token already exchanged');
    claimedJti = block.jti;

    // 11. Mint, exactly as the user exchange does.
    const jti = randomUUID();
    const scope = scopeNames(BLOCK_EXCHANGE_SCOPE);
    const minted = await mintExchangedJwt(
      tokenSigner,
      {
        iss: issuer,
        sub: String(block.userId),
        aud: resource.resource,
        client_id: block.appId,
        scope,
        jti,
        iat,
        exp,
        act: { sub: caller.id },
      },
      {
        kind: 'block-exchange',
        userId: block.userId,
        clientId: block.appId,
        actor: caller.id,
        resource: resource.resource,
        scopeBits: BLOCK_EXCHANGE_SCOPE,
        exp,
        blockJti: block.jti,
      },
      'block-exchange'
    );
    if (!minted.ok) return refuse('server_error', minted.reason);
    claimedJti = undefined;

    logOAuthEvent({
      type: 'block_exchange.issued',
      userId: block.userId,
      clientId: block.appId,
      scope: BLOCK_EXCHANGE_SCOPE,
      ip,
      metadata: {
        caller: caller.id,
        resource: resource.resource,
        appBlockId: block.appBlockId,
        blockJti: block.jti,
        jti,
        expiresIn: exp - iat,
      },
    });
    return json(
      {
        access_token: minted.accessToken,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: exp - iat,
        scope,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return refuse('temporarily_unavailable', `lookup failed: ${String(err)}`, {
      'Retry-After': '5',
    });
  } finally {
    // A claim this request made and did not turn into a token is given back.
    if (claimedJti !== undefined) {
      await releaseBlockTokenJti(claimedJti).catch((err) => {
        logOAuthEvent({
          type: 'block_exchange.refused',
          userId: ctx.userId,
          clientId: ctx.app,
          ip,
          metadata: { error: 'server_error', reason: `replay release failed: ${String(err)}` },
        });
      });
    }
  }
}
