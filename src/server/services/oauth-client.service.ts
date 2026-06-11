import { v4 as uuidv4 } from 'uuid';
import { dbWrite } from '~/server/db/client';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { deriveAllowedOriginsFromRedirectUris } from '~/server/schema/oauth-client.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export interface CreateOauthClientParams {
  /** Owner of the client. tRPC `create` passes the current user; DCR passes the
   * system bot user. */
  userId: number;
  name: string;
  description?: string;
  redirectUris: string[];
  allowedOrigins?: string[];
  /** Confidential clients get a generated secret; public clients get null. */
  isConfidential: boolean;
  allowedScopes: number;
  /** Grant types for this client. Defaults to the auth-code + refresh pair. */
  grants?: string[];
  /** Set true for RFC 7591 dynamically-registered clients. */
  isDynamicallyRegistered?: boolean;
  /** Optional logo URL (only set via DCR / update flows). */
  logoUrl?: string | null;
}

export interface CreateOauthClientResult {
  clientId: string;
  /** Plaintext secret — only returned once, only for confidential clients. */
  clientSecret: string | null;
  /** Final stored values, echoed back for callers that build a response body. */
  redirectUris: string[];
  allowedOrigins: string[];
  allowedScopes: number;
  grants: string[];
  isConfidential: boolean;
}

/**
 * Shared OAuth-client creation. Used by both the tRPC `oauthClient.create`
 * mutation (developer-registered clients) and the RFC 7591 `/register`
 * endpoint (dynamically-registered public clients).
 *
 * The caller is responsible for policy (who may create what scopes/grants);
 * this service just persists exactly what it's told and handles secret
 * generation + origin derivation.
 */
export async function createOauthClient(
  params: CreateOauthClientParams
): Promise<CreateOauthClientResult> {
  const clientId = uuidv4();
  const clientSecret = params.isConfidential ? generateKey(48) : null;
  const hashedSecret = clientSecret ? generateSecretHash(clientSecret) : null;

  // Public clients depend on Origin pinning for token-endpoint identity; if no
  // explicit origins were supplied, fall back to the origin part of the
  // redirect URIs so the client still works without typing hosts twice.
  const allowedOrigins =
    params.allowedOrigins && params.allowedOrigins.length > 0
      ? params.allowedOrigins
      : deriveAllowedOriginsFromRedirectUris(params.redirectUris);

  const grants = params.grants ?? ['authorization_code', 'refresh_token'];

  await dbWrite.oauthClient.create({
    data: {
      id: clientId,
      secret: hashedSecret,
      name: params.name,
      description: params.description ?? '',
      logoUrl: params.logoUrl ?? null,
      redirectUris: params.redirectUris,
      allowedOrigins,
      grants,
      isConfidential: params.isConfidential,
      allowedScopes: params.allowedScopes,
      userId: params.userId,
      isDynamicallyRegistered: params.isDynamicallyRegistered ?? false,
    },
  });

  logOAuthEvent({
    type: 'client.created',
    userId: params.userId,
    clientId,
    metadata: { isDynamicallyRegistered: params.isDynamicallyRegistered ?? false },
  });

  return {
    clientId,
    clientSecret,
    redirectUris: params.redirectUris,
    allowedOrigins,
    allowedScopes: params.allowedScopes,
    grants,
    isConfidential: params.isConfidential,
  };
}

/** Default grants for a public DCR client — never client_credentials. */
export const DCR_GRANTS = ['authorization_code', 'refresh_token'] as const;

/** Scope mask cap for DCR clients (never Full). See TokenScopePresets.MCPMaxAllowed. */
export { TokenScope };
