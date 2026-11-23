import { json } from '@sveltejs/kit';
import { createHash, randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getRedis } from '$lib/server/redis';
import { logOAuthEvent } from './audit-log';
import { userHasRole } from './access';
import { authenticatedConfidentialClient, clientIdMismatch } from './client-auth';
import { ACCESS_TOKEN_TYPE, SYSTEM_WORKLOAD_ROLE } from './constants';
import { findExchangeResource } from './exchange-resources';
import { basicCredentials } from './http';
import {
  chargeTokenExchangeFailure,
  checkTokenExchangeRateLimit,
  oauthRateLimitRef,
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
import { raceTimeout } from './timeout';

// RFC 8693 exchange of an App Block token for an AppDataRead `at+jwt` naming the calling relay in `act`, minted
// by `mintExchangedJwt` like the user exchange's (sub = viewer, client_id = the block's app, aud = resource,
// exp = min(block exp, now + 15 min), no refresh), so the adapter's private feed accepts it. Dark unless the
// caller is in OAUTH_BLOCK_EXCHANGE_CALLERS (empty by default). The required `apps:storage` scope is
// consent-exempt, so it is not the viewer's consent: access is decided by the allowlisted relay, the app's
// listing and `allowedScopes`, and the private feed's per-poll `decideCollectionRead`.
//
// The minted token carries the block token's binding (`@civitai/auth` `AccessTokenJwtClaims.block`), as five
// claims written together: `civitai_token_kind: 'block-exchange'`, `civitai_app_block_id`,
// `civitai_block_instance_id`, `civitai_max_browsing_level` and `civitai_viewer_browsing_level` (the viewer's
// own level, read with the ceiling as the site's `resolveViewerBrowsingLevel` reads them). With them the registry adapter's private feed
// (`src/server/registry-adapter/private-feed.ts`) reads no more than the site's document store would with the
// block token itself, on every poll: mature ratings within the token's ceiling, only while the token's block
// is its client's one approved block, and nothing once the install is revoked. The hub still refuses a token
// whose block is not the one approved block when it is exchanged (defence in depth; the feed is
// authoritative per poll). The ceiling is per resource: a resource that declares `narrowsBlockClaims`
// (exchange-resources.ts) is sent a token of any ceiling; any other resource only one whose ceiling admits
// every mature rating, so a resource that ignores the claims (an adapter older than them, or any other
// AppDataRead resource) can never read more than the token would. The explicit `civitai_token_kind` marker
// is kept although the other three claims alone would identify the token: a reader then never infers what
// a token is from which optional claims happen to be present. Refusals are `oauth-audit` events, except the
// two rate-limit 429s, which are not audited.

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

/**
 * R, X and XXX: the site's mature browsing-level bits (`NsfwLevel` in `src/server/common/enums.ts`, pinned by
 * `block-exchange.test.ts`). A resource that does not declare `narrowsBlockClaims` is sent only a token whose
 * ceiling holds all three.
 */
export const MATURE_BROWSING_LEVELS = 4 | 8 | 16;

/**
 * The viewer level written for a block token that carries none: PG, the site's `publicBrowsingLevelsFlag`,
 * which is what `resolveViewerBrowsingLevel` reads an absent `viewerBrowsingLevel` as (pinned by
 * `block-exchange.test.ts`). The minted token then reads exactly what the block token would on the site.
 */
export const ABSENT_VIEWER_BROWSING_LEVEL = 1;

/** The one scope a minted token holds. */
export const BLOCK_EXCHANGE_SCOPE = TokenScope.AppDataRead;

/**
 * The block-token scope required to exchange: the app declares a document-store collection. Consent-exempt,
 * so it says nothing about the viewer's consent (see the file comment).
 */
export const STORAGE_SCOPE = 'apps:storage';

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

type ReplayRedis = {
  set(key: string, value: string, opts: { NX: true; EX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

/** Delete KEYS[1] only while it holds ARGV[1]: one atomic compare-and-delete. */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const REPLAY_TIMEOUT_MS = 2000;

const replayKey = (jti: string) =>
  `auth:block-exchange:jti:${createHash('sha256').update(jti).digest('hex')}`;

/** One request's claim on a block token's `jti`: the value it SETs is its own `nonce`. */
type JtiClaim = { jti: string; nonce: string };

/**
 * Claim the block token's `jti` for one exchange, storing `claim.nonce` as the value. True when this request
 * claimed it, false when an earlier one did. Throws when the claim cannot be made (no Redis, an error, a
 * timeout): the caller refuses, since an unrecorded claim could be replayed. After a timeout the SET may
 * still land; if it does, the claim is given back then, so a retry is not refused for the token's life.
 */
async function claimBlockTokenJti(claim: JtiClaim, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis() as unknown as ReplayRedis | null;
  if (!redis) throw new Error('REDIS_URL is not configured');
  const set = redis.set(replayKey(claim.jti), claim.nonce, {
    NX: true,
    EX: Math.max(1, ttlSeconds),
  });
  try {
    return (await raceTimeout(set, REPLAY_TIMEOUT_MS, 'replay store timed out')) !== null;
  } catch (err) {
    void set
      .then((reply) => (reply !== null ? releaseBlockTokenJti(claim) : undefined))
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Give a `jti` back when no token was issued for it, so the caller's retry is not refused as a replay. Only
 * this request's own claim is deleted, by an atomic compare-and-delete on its nonce (RELEASE_SCRIPT): a
 * request whose claim lost, or whose SET never landed, never frees another request's claim.
 */
async function releaseBlockTokenJti(claim: JtiClaim): Promise<void> {
  const redis = getRedis() as unknown as ReplayRedis | null;
  if (!redis) return;
  await raceTimeout(
    redis.eval(RELEASE_SCRIPT, { keys: [replayKey(claim.jti)], arguments: [claim.nonce] }),
    REPLAY_TIMEOUT_MS,
    'replay store timed out'
  );
}

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
      return rateLimitedResponse(oauthRetryAfter('token-exchange'), headers, DESCRIPTION[error], {
        limit: oauthRateLimitRef('token-exchange'),
      });
    }
    return json(
      { error, error_description: DESCRIPTION[error] },
      { status: STATUS[error], headers }
    );
  };

  // A refusal before client authentication is charged to the IP (`token-exchange-ip`). This 429, like the
  // caller-limit 429 below, is not audited, so a flood cannot drive the audit log's volume.
  const basicAttempted = /^basic /i.test(request.headers.get('authorization') ?? '');
  const refuseUnauthenticated = async (error: ExchangeError, reason: string) => {
    if (!(await chargeTokenExchangeFailure(input.clientIp))) {
      return rateLimitedResponse(
        oauthRetryAfter('token-exchange'),
        new Headers(NO_STORE),
        DESCRIPTION.rate_limited,
        { limit: oauthRateLimitRef('token-exchange-ip') }
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

  // Set from just before the claim until a token is issued: `finally` gives it back whenever none was, a
  // timed-out claim included (its SET may have landed).
  let claim: JtiClaim | undefined;
  try {
    // Dark unless a caller is listed: checked before anything else is read.
    const allow = blockExchangeCallers();
    if (allow.callers.size === 0) {
      return refuseUnauthenticated(
        'unauthorized_client',
        allow.invalid ? 'caller allowlist invalid' : 'caller allowlist empty'
      );
    }

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

    if (clientIdMismatch(basicCredentials(request)?.id, body)) {
      return refuseUnauthenticated('invalid_client', 'client_id mismatch');
    }
    const caller = await authenticatedConfidentialClient(request, body);
    if (!caller) return refuseUnauthenticated('invalid_client', 'client authentication failed');
    ctx.caller = caller.id;
    // Unaudited 429 (see above), before any refusal a caller could repeat. The caller's one exchange budget,
    // shared with its user exchanges (so a staff-set limit is the caller's whole limit); a relay checks a block
    // token's signature itself before sending it (app-data-go), so made-up tokens do not reach it.
    if (!(await checkTokenExchangeRateLimit(caller.id, caller.tokenRateLimit))) {
      return rateLimitedResponse(
        oauthRetryAfter('token-exchange'),
        new Headers(NO_STORE),
        DESCRIPTION.rate_limited,
        { limit: oauthRateLimitRef('token-exchange') }
      );
    }
    if (!allow.callers.has(caller.id)) {
      return refuse('unauthorized_client', 'caller not allowlisted');
    }
    if (caller.accessMode === 'disabled') return refuse('unauthorized_client', 'caller disabled');

    const resource = await findExchangeResource(ctx.resource);
    if (!resource) return refuse('invalid_target', 'resource not registered');
    if ((resource.scopes & BLOCK_EXCHANGE_SCOPE) === 0n) {
      return refuse('invalid_target', 'resource does not receive AppDataRead');
    }
    if (!resource.relays.includes(caller.id)) {
      return refuse('unauthorized_client', 'caller not a relay of resource');
    }

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

    if (!block.scopes.includes(STORAGE_SCOPE)) {
      return refuse('invalid_grant', 'block token has no apps:storage scope');
    }

    if (!resource.apps.includes(block.appId)) {
      return refuse('unauthorized_client', 'app not listed for resource');
    }
    const app = await findExchangeClient(block.appId);
    if (!app) return refuse('invalid_grant', 'app not found');
    if (app.accessMode === 'disabled') return refuse('unauthorized_client', 'app disabled');
    if ((app.allowedScopes & BLOCK_EXCHANGE_SCOPE) === 0n) {
      return refuse('invalid_scope', 'app may not hold AppDataRead');
    }

    const userProblem = await userRefusal(block.userId, BLOCK_EXCHANGE_SCOPE, app);
    if (userProblem) return refuse(userProblem.refusal, userProblem.reason);
    if (await userHasRole(block.userId, SYSTEM_WORKLOAD_ROLE)) {
      return refuse('invalid_grant', 'workload account');
    }

    // The site's document store reads the token's own block. The registry's private feed holds every poll of
    // the minted token to its `civitai_app_block_id` being the client's one approved block (`DataReader.appBlockId`
    // in data-read-grant.ts), so that check is authoritative; this one refuses the same token here first
    // (defence in depth). It is the site's own rule (`clientIsOnlySource` / `resolveConsumer` in
    // data-read-grant.ts: the approved blocks of the client, at most two read), pinned by
    // `block-exchange.test.ts`. It also refuses an app with no approved block, a suspended one included, so
    // it replaces the mint lock's suspension check here.
    const approved = await db
      .selectFrom('app_blocks')
      .select('id')
      .where('app_id', '=', block.appId)
      .where('status', '=', 'approved')
      .limit(2)
      .execute();
    if (approved.length !== 1 || approved[0].id !== block.appBlockId) {
      return refuse('unauthorized_client', "block is not the app's one approved block");
    }
    // The site reads a block token's data within the token's own maturity ceiling (set from the host it was
    // minted on). The ceiling is carried into the minted token (`civitai_max_browsing_level`). A token with
    // no usable ceiling (absent, or not a non-negative integer: `verifyBlockTokenForExchange`) has nothing
    // to carry, so it is refused rather than given one.
    if (block.maxBrowsingLevel === null) {
      return refuse('invalid_grant', 'block token has no ceiling');
    }
    const ceiling = block.maxBrowsingLevel;
    // Only a resource that declares it narrows by the claims is sent a ceiling short of every mature rating.
    // Any other resource reads by the viewer's own settings, as a mature-capable surface, so it is sent a
    // token only when the ceiling admits every rating: it can then never admit one the token's own reads
    // would not. Undeclared is this strict rule.
    if (
      !resource.narrowsBlockClaims &&
      (ceiling & MATURE_BROWSING_LEVELS) !== MATURE_BROWSING_LEVELS
    ) {
      return refuse('invalid_grant', 'block token ceiling is not every rating');
    }
    // The feed checks the install's revocation markers by it, and refuses a token without one.
    if (!block.blockInstanceId) return refuse('invalid_grant', 'block token has no install');

    const issuer = env.AUTH_JWT_ISSUER;
    const tokenSigner = getSigner();
    if (!issuer || !tokenSigner)
      return refuse('server_error', 'issuer or signing key not configured');
    const iat = Math.floor(Date.now() / 1000);
    const exp = Math.min(block.exp, iat + EXCHANGED_TOKEN_MAX_TTL);
    if (exp <= iat) return refuse('invalid_grant', 'block token expiring');

    // Once per block token: claimed last, just before minting, and released in `finally` if no token is
    // issued, so a failure the caller may retry does not burn the block token.
    claim = { jti: block.jti, nonce: randomUUID() };
    let claimed: boolean;
    try {
      claimed = await claimBlockTokenJti(claim, block.exp - iat + 60);
    } catch (err) {
      return refuse('temporarily_unavailable', `replay check failed: ${String(err)}`, {
        'Retry-After': '5',
      });
    }
    if (!claimed) {
      // An earlier request holds the claim: not this request's to give back.
      claim = undefined;
      return refuse('invalid_grant', 'block token already exchanged');
    }

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
        block: {
          appBlockId: block.appBlockId,
          blockInstanceId: block.blockInstanceId,
          maxBrowsingLevel: ceiling,
          viewerBrowsingLevel: block.viewerBrowsingLevel ?? ABSENT_VIEWER_BROWSING_LEVEL,
        },
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
    claim = undefined;

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
    // A claim this request made (or may have made) and did not turn into a token is given back.
    if (claim !== undefined) {
      await releaseBlockTokenJti(claim).catch((err) => {
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
