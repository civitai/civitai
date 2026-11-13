import { json } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';
import { maybeCreateSessionSigner, type SessionSigner } from '@civitai/auth';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { logToAxiom } from '$lib/server/axiom';
import { authenticatedConfidentialClient, clientIdMismatch } from './client-auth';
import { ACCESS_TOKEN_TYPE } from './constants';
import { basicCredentials } from './http';
import { findExchangeResource } from './exchange-resources';
import { chargeTokenExchangeFailure, checkTokenExchangeRateLimit } from './rate-limit';
import { parseScopeRequest } from './scope';
import {
  EXCHANGED_TOKEN_MAX_TTL,
  exchangeScopeCeiling,
  findExchangeClient,
  findSubjectTokenByHash,
  scopeNames,
  subjectTokenRefusal,
  userRefusal,
  writeExchangeRecord,
} from './token-exchange';

// RFC 8693 token exchange of a user's OAuth access token for a short-lived RFC 9068 JWT (`typ: at+jwt`)
// whose `aud` is one registered resource (exchange-resources.ts). The caller is a confidential client:
// the app the token was issued to, or a relay the resource lists, which the JWT then names in `act`.
// Every refusal is a standard error body with Cache-Control: no-store; the reason is logged, not returned.

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

const STATUS: Record<ExchangeError, number> = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_target: 400,
  unauthorized_client: 400,
  invalid_grant: 400,
  invalid_scope: 400,
  rate_limited: 429,
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

let signer: SessionSigner | null | undefined;
function getSigner(): SessionSigner | null {
  if (signer === undefined) signer = maybeCreateSessionSigner() ?? null;
  return signer;
}

interface LogContext {
  caller?: string;
  app?: string;
  actor?: string;
  resource?: string;
  userId?: number;
  jti?: string;
  scope?: string;
}

function log(result: 'issued' | 'refused', ctx: LogContext, error?: string, reason?: string) {
  void logToAxiom({ event: 'token_exchange', result, error, reason, ...ctx }).catch(
    () => undefined
  );
}

export interface UserExchangeInput {
  request: Request;
  body: Record<string, string>;
  /** Every `resource` value the request carried (a form can repeat it). */
  resources: string[];
  clientIp: string | null;
  /** Whether the body was form-encoded, as RFC 8693 requires. */
  formEncoded: boolean;
}

/** Handle a token exchange whose `subject_token_type` is an access token. */
export async function handleUserTokenExchange(input: UserExchangeInput): Promise<Response> {
  const { request, body } = input;
  const ctx: LogContext = {};

  const refuse = (error: ExchangeError, reason: string, extra?: HeadersInit) => {
    log('refused', ctx, error, reason);
    const headers = new Headers({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    for (const [k, v] of new Headers(extra)) headers.set(k, v);
    return json(
      { error, error_description: DESCRIPTION[error] },
      { status: STATUS[error], headers }
    );
  };

  try {
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
    const resourceId = input.resources[0];
    ctx.resource = resourceId;

    // 2. Client authentication. Only failed checks are charged to the caller's IP, so a caller whose
    // secret checks out is never refused by that limit.
    const basicAttempted = /^basic /i.test(request.headers.get('authorization') ?? '');
    const unauthenticated = async (reason: string) => {
      const withinLimit = await chargeTokenExchangeFailure(input.clientIp);
      if (!withinLimit) return refuse('rate_limited', reason, { 'Retry-After': '60' });
      return refuse(
        'invalid_client',
        reason,
        basicAttempted ? { 'WWW-Authenticate': 'Basic realm="Service"' } : undefined
      );
    };
    // Checked against the Basic id as authenticatedConfidentialClient reads it.
    if (clientIdMismatch(basicCredentials(request)?.id, body)) {
      return unauthenticated('client_id mismatch');
    }
    const caller = await authenticatedConfidentialClient(request, body);
    if (!caller) return unauthenticated('client authentication failed');
    ctx.caller = caller.id;
    if (!(await checkTokenExchangeRateLimit(caller.id, caller.tokenRateLimit))) {
      return refuse('rate_limited', 'client limit', { 'Retry-After': '60' });
    }
    if (caller.accessMode === 'disabled') return refuse('unauthorized_client', 'caller disabled');

    // 3. Resource.
    const resource = await findExchangeResource(resourceId);
    if (!resource) return refuse('invalid_target', 'resource not registered');

    // 4. The caller is on the resource's lists.
    if (!resource.apps.includes(caller.id) && !resource.relays.includes(caller.id)) {
      return refuse('unauthorized_client', 'caller not listed for resource');
    }

    // 5. The subject token.
    const now = new Date();
    const subject = await findSubjectTokenByHash(generateSecretHash(subjectToken), now);
    if (!subject) return refuse('invalid_grant', 'subject token not found');
    ctx.app = subject.clientId;
    ctx.userId = subject.userId;
    const subjectRefusal = await subjectTokenRefusal(subject);
    if (subjectRefusal) return refuse('invalid_grant', subjectRefusal);

    // 6. The app the token was issued to is allowed for this resource.
    if (!resource.apps.includes(subject.clientId)) {
      return refuse('unauthorized_client', 'app not listed for resource');
    }

    // 7. A direct exchange by the app, or a relay acting for it.
    let actor: string | undefined;
    if (caller.id !== subject.clientId) {
      if (!resource.relays.includes(caller.id)) {
        return refuse('unauthorized_client', 'caller is neither the app nor a relay');
      }
      actor = caller.id;
      ctx.actor = actor;
    }

    const app = await findExchangeClient(subject.clientId);
    if (!app) return refuse('invalid_grant', 'app not found');
    if (app.accessMode === 'disabled') return refuse('unauthorized_client', 'app disabled');

    // 9. Scope: what the token holds, within the resource's cap and the app's current ceiling, narrowed
    // to a request that names only scopes within that.
    const ceiling = exchangeScopeCeiling(subject.tokenScope, resource, app);
    let scope = ceiling;
    if (body.scope !== undefined) {
      const requested = parseScopeRequest(body.scope);
      if (!requested || requested.openid) return refuse('invalid_scope', 'unparseable scope');
      if ((requested.scope & ~ceiling) !== 0) return refuse('invalid_scope', 'scope outside grant');
      scope = requested.scope;
    }
    if (scope === 0) return refuse('invalid_scope', 'empty scope');
    ctx.scope = scopeNames(scope);

    // 8. The user, against the final scope.
    const userProblem = await userRefusal(subject.userId, scope, app);
    if (userProblem) return refuse(userProblem.refusal, userProblem.reason);

    // 10. Issuer and key.
    const issuer = env.AUTH_JWT_ISSUER;
    const tokenSigner = getSigner();
    if (!issuer || !tokenSigner) {
      void logToAxiom({ type: 'error', name: 'token-exchange-not-configured' }).catch(
        () => undefined
      );
      return refuse('server_error', 'issuer or signing key not configured');
    }

    const iat = Math.floor(now.getTime() / 1000);
    const exp = Math.min(
      Math.floor(subject.expiresAt.getTime() / 1000),
      iat + EXCHANGED_TOKEN_MAX_TTL
    );
    if (exp <= iat) return refuse('invalid_grant', 'subject token expiring');
    const jti = randomUUID();
    ctx.jti = jti;

    let accessToken: string;
    try {
      accessToken = await tokenSigner.mintAccessTokenJwt({
        iss: issuer,
        sub: String(subject.userId),
        aud: resource.resource,
        client_id: subject.clientId,
        scope: ctx.scope,
        jti,
        iat,
        exp,
        ...(actor ? { act: { sub: actor } } : {}),
      });
    } catch (err) {
      void logToAxiom({
        type: 'error',
        name: 'token-exchange-sign-failed',
        message: String(err),
      }).catch(() => undefined);
      return refuse('server_error', 'signing failed');
    }

    // Introspection reads this record; a token without one would never read as active, so none is issued.
    try {
      await writeExchangeRecord(
        jti,
        {
          subjectKeyId: subject.id,
          userId: subject.userId,
          clientId: subject.clientId,
          actor: actor ?? null,
          resource: resource.resource,
          scopeBits: scope,
          exp,
        },
        iat
      );
    } catch (err) {
      void logToAxiom({
        type: 'error',
        name: 'token-exchange-record-failed',
        message: String(err),
      }).catch(() => undefined);
      return refuse('server_error', 'exchange record not stored');
    }

    log('issued', ctx);
    return json(
      {
        access_token: accessToken,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: exp - iat,
        scope: ctx.scope,
      },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } }
    );
  } catch (err) {
    void logToAxiom({ type: 'error', name: 'token-exchange-error', message: String(err) }).catch(
      () => undefined
    );
    return refuse('temporarily_unavailable', 'lookup failed', { 'Retry-After': '5' });
  }
}
