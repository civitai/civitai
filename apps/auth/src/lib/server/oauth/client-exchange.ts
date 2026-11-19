import { json } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';
import { createAccessTokenJwtVerifier } from '@civitai/auth';
import { db } from '$lib/server/db/db';
import { logToAxiom } from '$lib/server/axiom';
import { authenticatedConfidentialClient, clientIdMismatch } from './client-auth';
import { ACCESS_TOKEN_TYPE } from './constants';
import { basicCredentials } from './http';
import { findExchangeResource, isServiceClient, isServiceClientId } from './exchange-resources';
import { chargeTokenExchangeFailure, checkTokenExchangeRateLimit } from './rate-limit';
import { parseScopeRequest } from './scope';
import {
  EXCHANGED_TOKEN_MAX_TTL,
  readExchangeRecord,
  scopeNames,
  writeExchangeRecord,
} from './token-exchange';
import { getSigner } from './user-exchange';

// RFC 8693 token exchange of a SERVICE's own token (a client acting as itself, no user) for a short-lived
// RFC 9068 JWT for one registered resource, by a relay in front of that resource. The subject is a JWT this
// hub issued with no user: a service token (service-token.ts) or a token this exchange minted, so the same
// call serves every hop of a chain of relays (consumer → relay → … → origin).
//
// The minted token has the format of a service token: `sub` = `client_id` = the service client (no user),
// `aud` = the resource, and `act.sub` = the relay that exchanged it. It carries no `roles` or
// `civitai_uid`: those are a resource's `services` entry, and the service is not one of the resource's
// services, only a subject of its relays. A resource decides for itself what that client may read.
//
// Exchanged only when, all of:
//   - the caller is an authenticated confidential client on the TARGET resource's `relays`;
//   - the subject verifies as this hub's at+jwt, `sub` equals `client_id` and is a service client id (never
//     a user's numeric id), and the hub's record of it matches (it was issued here and is still recorded);
//   - the subject's own resource is registered and lists the caller as an introspector, i.e. the caller
//     is a server of the resource the subject was issued for, so a relay cannot pass on a token issued
//     to someone else;
//   - the target resource lists the service in `serviceSubjects` (exchange-resources.ts; empty by default,
//     so by default nothing is exchanged), and its client row is still an active service client.
// A user's token is never a subject here: a numeric `sub` is refused, and a user's opaque token takes the
// user exchange (user-exchange.ts), which this file does not touch.

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

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

let verifier: ReturnType<typeof createAccessTokenJwtVerifier> | undefined;

export interface ClientExchangeInput {
  request: Request;
  body: Record<string, string>;
  /** Every `resource` value the request carried (a form can repeat it). */
  resources: string[];
  clientIp: string | null;
  /** Whether the body was form-encoded, as RFC 8693 requires. */
  formEncoded: boolean;
}

/** Handle a token exchange whose subject is a hub-issued access token JWT. */
export async function handleClientTokenExchange(input: ClientExchangeInput): Promise<Response> {
  const { request, body } = input;
  // The log line of every outcome: `service` (the subject's client), `relay` (the caller), `resource`
  // (the target) and `source` (the subject's resource), as far as each is known. Never a token.
  const ctx: Record<string, string | undefined> = {};

  const refuse = (error: ExchangeError, reason: string, extra?: HeadersInit) => {
    void logToAxiom({ event: 'client_token_exchange', result: 'refused', error, reason, ...ctx });
    const headers = new Headers(NO_STORE);
    for (const [k, v] of new Headers(extra)) headers.set(k, v);
    return json(
      { error, error_description: DESCRIPTION[error] },
      { status: STATUS[error], headers }
    );
  };

  try {
    // 1. Parameters, as the user exchange takes them.
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
    const targetId = input.resources[0];
    ctx.resource = targetId;

    // 2. Client authentication: only failed checks are charged to the caller's IP.
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
    if (clientIdMismatch(basicCredentials(request)?.id, body)) {
      return unauthenticated('client_id mismatch');
    }
    const caller = await authenticatedConfidentialClient(request, body);
    if (!caller) return unauthenticated('client authentication failed');
    ctx.relay = caller.id;
    if (!(await checkTokenExchangeRateLimit(caller.id, caller.tokenRateLimit))) {
      return refuse('rate_limited', 'client limit', { 'Retry-After': '60' });
    }
    if (caller.accessMode === 'disabled') return refuse('unauthorized_client', 'caller disabled');

    // 3. The target resource, and the caller is one of its relays.
    const target = await findExchangeResource(targetId);
    if (!target) return refuse('invalid_target', 'resource not registered');
    if (!target.relays.includes(caller.id)) {
      return refuse('unauthorized_client', 'caller not a relay of resource');
    }

    // 4. The subject: this hub's at+jwt, for a client as itself.
    const issuer = env.AUTH_JWT_ISSUER;
    const tokenSigner = getSigner();
    if (!issuer || !tokenSigner) {
      void logToAxiom({ type: 'error', name: 'client-token-exchange-not-configured' });
      return refuse('server_error', 'issuer or signing key not configured');
    }
    verifier ??= createAccessTokenJwtVerifier();
    const payload = (await verifier(subjectToken, issuer)) as Record<string, unknown> | null;
    if (!payload) return refuse('invalid_grant', 'subject signature or claims');
    const { sub, client_id: clientId, aud, jti, exp } = payload;
    if (
      typeof sub !== 'string' ||
      typeof clientId !== 'string' ||
      typeof aud !== 'string' ||
      typeof jti !== 'string' ||
      typeof exp !== 'number'
    ) {
      return refuse('invalid_grant', 'subject claim shape');
    }
    ctx.service = clientId;
    ctx.source = aud;
    if (sub !== clientId || !isServiceClientId(clientId)) {
      return refuse('invalid_grant', 'subject is not a service token');
    }

    // 5. The subject was issued for a resource the caller serves.
    const source = await findExchangeResource(aud);
    if (!source) return refuse('invalid_grant', 'subject resource not registered');
    if (!source.introspectors.includes(caller.id)) {
      return refuse('unauthorized_client', 'caller does not serve the subject resource');
    }

    // 6. The hub's record of the subject.
    const record = await readExchangeRecord(jti);
    if (
      !record ||
      (record.kind !== 'service' && record.kind !== 'service-exchange') ||
      record.clientId !== clientId ||
      record.resource !== aud
    ) {
      return refuse('invalid_grant', 'no matching subject record');
    }

    // 7. The target lists the service as a subject, and its client is still an active service client.
    if (!target.serviceSubjects.includes(clientId)) {
      return refuse('unauthorized_client', 'service not a subject of resource');
    }
    const row = await db
      .selectFrom('OauthClient')
      .select(['userId', 'grants', 'accessMode'])
      .where('id', '=', clientId)
      .executeTakeFirst();
    if (!row || !isServiceClient(row)) return refuse('unauthorized_client', 'service not active');

    // 8. Scope: what the subject holds, within the target's cap, narrowed to a request within that.
    const ceiling = record.scopeBits & target.scopes;
    let scope = ceiling;
    if (body.scope !== undefined) {
      const requested = parseScopeRequest(body.scope);
      if (!requested || requested.openid) return refuse('invalid_scope', 'unparseable scope');
      if ((requested.scope & ~ceiling) !== 0n)
        return refuse('invalid_scope', 'scope outside grant');
      scope = requested.scope;
    }
    if (scope === 0n) return refuse('invalid_scope', 'empty scope');
    ctx.scope = scopeNames(scope);

    // 9. Mint: never past the subject, at most 15 minutes.
    const iat = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(exp, iat + EXCHANGED_TOKEN_MAX_TTL);
    if (expiresAt <= iat) return refuse('invalid_grant', 'subject token expiring');
    const newJti = randomUUID();
    ctx.jti = newJti;

    let accessToken: string;
    try {
      accessToken = await tokenSigner.mintAccessTokenJwt({
        iss: issuer,
        sub: clientId,
        aud: target.resource,
        client_id: clientId,
        scope: ctx.scope,
        jti: newJti,
        iat,
        exp: expiresAt,
        act: { sub: caller.id },
      });
    } catch (err) {
      void logToAxiom({
        type: 'error',
        name: 'client-token-exchange-sign-failed',
        message: String(err),
      });
      return refuse('server_error', 'signing failed');
    }

    try {
      await writeExchangeRecord(
        newJti,
        {
          kind: 'service-exchange',
          clientId,
          actor: caller.id,
          resource: target.resource,
          scopeBits: scope,
          exp: expiresAt,
          subjectJti: jti,
        },
        iat
      );
    } catch (err) {
      void logToAxiom({
        type: 'error',
        name: 'client-token-exchange-record-failed',
        message: String(err),
      });
      return refuse('server_error', 'exchange record not stored');
    }

    void logToAxiom({ event: 'client_token_exchange', result: 'issued', ...ctx });
    return json(
      {
        access_token: accessToken,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: expiresAt - iat,
        scope: ctx.scope,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    void logToAxiom({ type: 'error', name: 'client-token-exchange-error', message: String(err) });
    return refuse('temporarily_unavailable', 'lookup failed', { 'Retry-After': '5' });
  }
}
