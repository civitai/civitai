import { json } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';
import { logToAxiom } from '$lib/server/axiom';
import { authenticatedConfidentialClient, clientIdMismatch } from './client-auth';
import { SERVICE_GRANT } from './constants';
import { findExchangeResource, isServiceClient } from './exchange-resources';
import { basicCredentials } from './http';
import { checkOAuthRateLimit, oauthRetryAfter, rateLimitedResponse } from './rate-limit';
import { parseScopeRequest } from './scope';
import { EXCHANGED_TOKEN_MAX_TTL, scopeNames, writeExchangeRecord } from './token-exchange';
import { getSigner } from './user-exchange';

// client_credentials with a `resource`, from a service client: a short-lived RFC 9068 JWT (`typ: at+jwt`)
// for one registered resource, issued to the client as itself (`sub` = `client_id`). The resource's
// `services` entry sets its scopes, `roles` and `civitai_uid`. Any other client_credentials request takes
// the library's path, `resource` or not.

type ServiceTokenError =
  | 'invalid_request'
  | 'invalid_target'
  | 'unauthorized_client'
  | 'invalid_scope'
  | 'rate_limited'
  | 'server_error'
  | 'temporarily_unavailable';

const STATUS: Record<Exclude<ServiceTokenError, 'rate_limited'>, number> = {
  invalid_request: 400,
  invalid_target: 400,
  unauthorized_client: 400,
  invalid_scope: 400,
  server_error: 500,
  temporarily_unavailable: 503,
};

const DESCRIPTION: Record<ServiceTokenError, string> = {
  invalid_request: 'Invalid token request',
  invalid_target: 'Unknown resource',
  unauthorized_client: 'This client may not get a token for this resource',
  invalid_scope: 'Invalid scope',
  rate_limited: 'Too many token requests',
  server_error: 'Internal error',
  temporarily_unavailable: 'Try again',
};

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export type ServiceClient = NonNullable<
  Awaited<ReturnType<typeof authenticatedConfidentialClient>>
>;

/**
 * The authenticated client of a client_credentials request, when it holds the service grant and nothing
 * else; otherwise null, and the request takes the general token path unchanged.
 */
export async function serviceTokenClient(
  request: Request,
  body: Record<string, unknown>
): Promise<ServiceClient | null> {
  if (clientIdMismatch(basicCredentials(request)?.id, body)) return null;
  const client = await authenticatedConfidentialClient(request, body);
  if (!client || client.grants.length !== 1 || client.grants[0] !== SERVICE_GRANT) return null;
  return client;
}

export interface ServiceTokenInput {
  client: ServiceClient;
  body: Record<string, string>;
  /** Every `resource` value of a form body; none for any other body. */
  resources: string[];
}

export async function handleServiceToken(input: ServiceTokenInput): Promise<Response> {
  const { client, body } = input;
  const ctx: Record<string, string | undefined> = { client: client.id };

  const refuse = (error: ServiceTokenError, reason: string, extra?: Record<string, string>) => {
    void logToAxiom({ event: 'service_token', result: 'refused', error, reason, ...ctx });
    if (error === 'rate_limited') {
      return rateLimitedResponse(
        oauthRetryAfter('token-service'),
        { ...NO_STORE, ...extra },
        DESCRIPTION[error]
      );
    }
    return json(
      { error, error_description: DESCRIPTION[error] },
      { status: STATUS[error], headers: { ...NO_STORE, ...extra } }
    );
  };

  try {
    if (!(await checkOAuthRateLimit('token-service', client.id))) {
      return refuse('rate_limited', 'client limit');
    }
    if (input.resources.length !== 1 || !input.resources[0]) {
      return refuse('invalid_request', 'exactly one resource is required');
    }
    const resourceId = input.resources[0];
    ctx.resource = resourceId;
    if (!isServiceClient(client))
      return refuse('unauthorized_client', 'not an active service client');

    const resource = await findExchangeResource(resourceId);
    if (!resource) return refuse('invalid_target', 'resource not registered');
    const entry = resource.services.find((s) => s.client === client.id);
    if (!entry) return refuse('unauthorized_client', 'not a service of this resource');

    let scope = entry.scopes;
    if (body.scope !== undefined) {
      const requested = parseScopeRequest(body.scope);
      if (!requested || requested.openid) return refuse('invalid_scope', 'unparseable scope');
      if ((requested.scope & ~entry.scopes) !== 0n) {
        return refuse('invalid_scope', 'scope outside entry');
      }
      scope = requested.scope;
    }
    if (scope === 0n) return refuse('invalid_scope', 'empty scope');
    ctx.scope = scopeNames(scope);

    const issuer = env.AUTH_JWT_ISSUER;
    const tokenSigner = getSigner();
    if (!issuer || !tokenSigner) {
      void logToAxiom({ type: 'error', name: 'service-token-not-configured' });
      return refuse('server_error', 'issuer or signing key not configured');
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + EXCHANGED_TOKEN_MAX_TTL;
    const jti = randomUUID();
    ctx.jti = jti;

    let accessToken: string;
    try {
      accessToken = await tokenSigner.mintAccessTokenJwt({
        iss: issuer,
        sub: client.id,
        aud: resource.resource,
        client_id: client.id,
        scope: ctx.scope,
        jti,
        iat,
        exp,
        roles: entry.roles,
        civitai_uid: entry.uid,
      });
    } catch (err) {
      void logToAxiom({
        type: 'error',
        name: 'service-token-sign-failed',
        message: String(err),
      });
      return refuse('server_error', 'signing failed');
    }

    // Introspection reads this record; a token without one would never read as active, so none is issued.
    try {
      await writeExchangeRecord(
        jti,
        {
          kind: 'service',
          clientId: client.id,
          resource: resource.resource,
          scopeBits: scope,
          exp,
        },
        iat
      );
    } catch (err) {
      void logToAxiom({
        type: 'error',
        name: 'service-token-record-failed',
        message: String(err),
      });
      return refuse('server_error', 'token record not stored');
    }

    void logToAxiom({ event: 'service_token', result: 'ok', ...ctx });
    return json(
      { access_token: accessToken, token_type: 'Bearer', expires_in: exp - iat, scope: ctx.scope },
      { headers: NO_STORE }
    );
  } catch (err) {
    void logToAxiom({ type: 'error', name: 'service-token-error', message: String(err) });
    return refuse('temporarily_unavailable', 'lookup failed', { 'Retry-After': '5' });
  }
}
