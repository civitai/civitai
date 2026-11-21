import { json } from '@sveltejs/kit';
import { createHash } from 'crypto';
import { env } from '$env/dynamic/private';
import { TokenScope } from '@civitai/auth/token-scope';
import { getRedis } from '$lib/server/redis';
import { logOAuthEvent } from './audit-log';
import { authenticatedConfidentialClient, clientIdMismatch } from './client-auth';
import { ACCESS_TOKEN_TYPE, BLOCK_EXCHANGE_TOKEN_MAX_TTL, SYSTEM_WORKLOAD_ROLE } from './constants';
import { userHasRole } from './access';
import { basicCredentials } from './http';
import { findExchangeResource } from './exchange-resources';
import {
  chargeTokenExchangeFailure,
  checkOAuthRateLimit,
  checkTokenExchangeRateLimit,
  oauthRetryAfter,
  rateLimitedResponse,
} from './rate-limit';
import { parseScopeRequest } from './scope';
import { findExchangeClient, userRefusal } from './token-exchange';
import { AppBlockSuspendedError, createBlockExchangeToken } from './token-helpers';
import { verifyBlockTokenForExchange } from './block-token-verify';

// RFC 8693 token exchange of an App Block token (the RS256 JWT the site signs for a block acting for a
// signed-in viewer) for a short-lived OPAQUE registry access token: an `ApiKey` row of type Access for
// (the viewer, the block's app), so the site's bearer lookup and the registry adapter's opaque path read it
// as that app's OAuth token for that user (`subject.type === 'oauth'`).
//
// The minted token:
//   - holds EXACTLY `AppDataRead`, whatever the block token carries (no UserRead baseline);
//   - lives at most 15 minutes and never past the block token's own `exp`;
//   - has no refresh token.
//
// DARK BY DEFAULT. Only a confidential client named in OAUTH_BLOCK_EXCHANGE_CALLERS may call it, and that list
// is empty unless someone sets it: empty (or invalid) refuses every request before anything else is read.
// An entry is added only with Justin's approval.
//
// Exchanged only when, all of:
//   1. the request is a well-formed exchange: form-encoded, one `subject_token`, exactly one `resource`, no
//      actor token, `requested_token_type` absent or an access token, `scope` absent or exactly AppDataRead;
//   2. the caller list is non-empty, the caller authenticates as a confidential client, is on the list, is
//      within its `token-exchange` limit and is not disabled;
//   3. `resource` is registered (OAUTH_EXCHANGE_RESOURCES), may receive AppDataRead, and lists the caller as a
//      relay: the same resource rules the user token exchange (user-exchange.ts) applies;
//   4. the block token verifies as the site's (block-token-verify.ts) for a signed-in viewer, and is not a
//      dev, review or private-run token;
//   5. it carries the viewer's document-store grant, the `apps:storage` scope;
//   6. it was never exchanged before (its `jti` is claimed once, fail closed);
//   7. the block's app is a client the resource lists in `apps`, is not disabled and may hold AppDataRead;
//   8. the viewer may hold the token through that app (user-exchange.ts `userRefusal`: app access mode,
//      deleted, banned, moderation account) and is not a workload account;
//   9. the (viewer, app) pair is within its `block-exchange` limit;
//  10. no block of the app is suspended without an approved one (checked under the suspension lock).
// Every outcome is an `oauth-audit` event (`block_exchange.issued` / `block_exchange.refused`) with the
// reason; the response carries only the standard error. No log line carries a token.
//
// REVOCATION: the minted token is a row like the app's own OAuth tokens, so everything that deletes those
// deletes it at once: the user revoking the app (`revokeApp`, `revokeOauthConsentForBlock`) and a suspension
// (`revokeAppBlockOauthTokens`). The block INSTANCE revocation the site checks per request (uninstall,
// `BlockRevocation`, held in the site's cache Redis) is not read here; a token minted before such a revocation
// lives out its time, at most the block token's own remaining lifetime (≤ 15 minutes). The registry's private
// feed re-runs its grant predicate on every poll, so a revoked import grant or an unapproved app stops the
// data whatever the token.

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
const BLOCK_EXCHANGE_SCOPE_NAME = 'AppDataRead';

/** The block-token scope that is the viewer's document-store grant. */
export const STORAGE_GRANT_SCOPE = 'apps:storage';

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

function blockExchangeCallers(): ReadonlySet<string> {
  const parsed = parseBlockExchangeCallers(env.OAUTH_BLOCK_EXCHANGE_CALLERS);
  if ('error' in parsed) {
    logOAuthEvent({
      type: 'block_exchange.refused',
      metadata: { error: 'server_error', reason: parsed.error },
    });
    return new Set();
  }
  return parsed.callers;
}

// ─── Replay: a block token is exchanged once ──────────────────

type NxRedis = {
  set(key: string, value: string, opts: { NX: true; EX: number }): Promise<string | null>;
};

const REPLAY_TIMEOUT_MS = 2000;

/**
 * Claim the block token's `jti` for one exchange. True when this request claimed it, false when an earlier
 * one did. Throws when the claim cannot be made (no Redis, an error, a timeout): the caller refuses, since an
 * unrecorded claim could be replayed.
 */
async function claimBlockTokenJti(jti: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis() as unknown as NxRedis | null;
  if (!redis) throw new Error('REDIS_URL is not configured');
  const key = `auth:block-exchange:jti:${createHash('sha256').update(jti).digest('hex')}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('replay claim timed out')), REPLAY_TIMEOUT_MS);
  });
  try {
    const reply = await Promise.race([
      redis.set(key, '1', { NX: true, EX: Math.max(1, ttlSeconds) }),
      timeout,
    ]);
    return reply !== null;
  } finally {
    clearTimeout(timer);
  }
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

  try {
    // 0. Dark unless a caller is listed: nothing else is read.
    const callers = blockExchangeCallers();
    if (callers.size === 0) return refuse('unauthorized_client', 'caller allowlist empty');

    // 1. Parameters.
    if (!input.formEncoded) return refuse('invalid_request', 'not form-encoded');
    const subjectToken = body.subject_token;
    if (typeof subjectToken !== 'string' || !subjectToken) {
      return refuse('invalid_request', 'missing subject_token');
    }
    if (input.resources.length !== 1 || !input.resources[0]) {
      return refuse('invalid_request', 'exactly one resource is required');
    }
    if (
      body.requested_token_type !== undefined &&
      body.requested_token_type !== ACCESS_TOKEN_TYPE
    ) {
      return refuse('invalid_request', 'unsupported requested_token_type');
    }
    if (body.actor_token !== undefined || body.actor_token_type !== undefined) {
      return refuse('invalid_request', 'actor_token is not supported');
    }
    if (body.scope !== undefined) {
      const requested = parseScopeRequest(body.scope);
      if (!requested || requested.openid || requested.scope !== BLOCK_EXCHANGE_SCOPE) {
        return refuse('invalid_scope', 'scope must be AppDataRead');
      }
    }
    ctx.resource = input.resources[0];

    // 2. Client authentication, then the allowlist. Only failed checks are charged to the caller's IP.
    const basicAttempted = /^basic /i.test(request.headers.get('authorization') ?? '');
    const unauthenticated = async (reason: string) => {
      const withinLimit = await chargeTokenExchangeFailure(input.clientIp);
      if (!withinLimit) return refuse('rate_limited', reason);
      return refuse(
        'invalid_client',
        reason,
        basicAttempted ? { 'WWW-Authenticate': 'Basic realm="Service"' } : undefined
      );
    };
    if (clientIdMismatch(basicCredentials(request)?.id, body)) {
      return unauthenticated('client_id mismatch');
    }
    const caller = await authenticatedConfidentialClient(request, body);
    if (!caller) return unauthenticated('client authentication failed');
    ctx.caller = caller.id;
    if (!callers.has(caller.id)) return refuse('unauthorized_client', 'caller not allowlisted');
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
      if (verified.reason === 'not configured') {
        return refuse('server_error', 'block token keys not configured');
      }
      return refuse('invalid_grant', `block token ${verified.reason}`);
    }
    const block = verified.token;
    ctx.app = block.appId;
    ctx.appBlockId = block.appBlockId;
    ctx.blockJti = block.jti;
    ctx.userId = block.userId;

    // 5. The viewer's storage grant.
    if (!block.scopes.includes(STORAGE_GRANT_SCOPE)) {
      return refuse('invalid_grant', 'block token has no storage grant');
    }

    // 6. Once per block token.
    const nowSeconds = Math.floor(Date.now() / 1000);
    let claimed: boolean;
    try {
      claimed = await claimBlockTokenJti(block.jti, block.exp - nowSeconds + 60);
    } catch (err) {
      return refuse('temporarily_unavailable', `replay check failed: ${String(err)}`, {
        'Retry-After': '5',
      });
    }
    if (!claimed) return refuse('invalid_grant', 'block token already exchanged');

    // 7. The block's app.
    if (!resource.apps.includes(block.appId)) {
      return refuse('unauthorized_client', 'app not listed for resource');
    }
    const app = await findExchangeClient(block.appId);
    if (!app) return refuse('invalid_grant', 'app not found');
    if (app.accessMode === 'disabled') return refuse('unauthorized_client', 'app disabled');
    if ((app.allowedScopes & BLOCK_EXCHANGE_SCOPE) === 0n) {
      return refuse('invalid_scope', 'app may not hold AppDataRead');
    }

    // 8. The viewer.
    const userProblem = await userRefusal(block.userId, BLOCK_EXCHANGE_SCOPE, app);
    if (userProblem) return refuse(userProblem.refusal, userProblem.reason);
    if (await userHasRole(block.userId, SYSTEM_WORKLOAD_ROLE)) {
      return refuse('invalid_grant', 'workload account');
    }

    // 9. Per (viewer, app).
    if (!(await checkOAuthRateLimit('block-exchange', `${block.userId}:${block.appId}`))) {
      return refuse('rate_limited', 'user-app limit');
    }

    // 10. Mint: at most 15 minutes, never past the block token.
    const exp = Math.min(block.exp, nowSeconds + BLOCK_EXCHANGE_TOKEN_MAX_TTL);
    if (exp <= nowSeconds) return refuse('invalid_grant', 'block token expiring');
    let accessToken: string;
    try {
      accessToken = await createBlockExchangeToken(
        block.userId,
        block.appId,
        BLOCK_EXCHANGE_SCOPE,
        new Date(exp * 1000)
      );
    } catch (err) {
      if (err instanceof AppBlockSuspendedError) {
        return refuse('unauthorized_client', 'app block suspended');
      }
      throw err;
    }

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
        expiresIn: exp - nowSeconds,
      },
    });
    return json(
      {
        access_token: accessToken,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: exp - nowSeconds,
        scope: BLOCK_EXCHANGE_SCOPE_NAME,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return refuse('temporarily_unavailable', `lookup failed: ${String(err)}`, {
      'Retry-After': '5',
    });
  }
}
