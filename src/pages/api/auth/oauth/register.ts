import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import requestIp from 'request-ip';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkRegisterRateLimit } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { isAllowedDcrRedirectUri } from '~/server/oauth/redirect-uri';
import { createOauthClient, DCR_GRANTS } from '~/server/services/oauth-client.service';
import {
  TokenScope,
  TokenScopePresets,
  scopeNamesToBitmask,
  bitmaskToScopeNames,
  tokenScopeNameToFlag,
} from '~/shared/constants/token-scope.constants';

/**
 * RFC 7591 — OAuth 2.0 Dynamic Client Registration.
 *
 * POST /api/auth/oauth/register
 *
 * Open + unauthenticated by design (enables MCP one-click auth), hardened with:
 *   - IP rate limit: 5/hour AND 20/day (see rate-limit.ts).
 *   - redirect_uri allowlist: https://<host> OR loopback http only.
 *   - Forced public client: token_endpoint_auth_method=none, no secret,
 *     grant_types limited to authorization_code + refresh_token.
 *   - Scope cap: clamped to TokenScopePresets.MCPMaxAllowed (never Full, never
 *     any Delete / SocialTip / AIServicesWrite / BountiesWrite). Even if a
 *     client later requests more at /authorize, validateScope clamps to the
 *     stored allowedScopes.
 *   - Owner: a dedicated system user (env OAUTH_DCR_OWNER_USER_ID). If unset,
 *     returns 503 temporarily_unavailable (fail-safe).
 *
 * Returns the RFC 7591 client information response (201).
 */

// RFC 7591 client metadata we accept. Unknown fields are ignored.
const registerSchema = z.object({
  // Required: at least one redirect URI.
  redirect_uris: z.array(z.string()).min(1),
  // Optional human-readable name shown on the consent screen.
  client_name: z.string().min(1).max(128).optional(),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  // Space-delimited scope string (RFC 6749). Optional — defaults to MCPDefault.
  scope: z.string().optional(),
  // RFC 7591 allows these; we validate them against our forced-public policy.
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

function error(res: NextApiResponse, status: number, error: string, error_description: string) {
  return res.status(status).json({ error, error_description });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'OPTIONS') {
    const shouldStop = addCorsHeaders(req, res, ['POST']);
    if (shouldStop) return;
  }

  // Open registration is browser/agent-callable cross-origin; keep CORS open
  // (no credentials — the response carries no secret).
  addCorsHeaders(req, res, ['POST']);

  if (req.method !== 'POST') {
    return error(res, 405, 'invalid_request', 'Method not allowed');
  }

  const ip = requestIp.getClientIp(req) ?? '';

  // Rate-limit by IP before any work.
  const allowed = await checkRegisterRateLimit(res, ip || 'unknown');
  if (!allowed) {
    logOAuthEvent({ type: 'client.created', ip, metadata: { rateLimited: true, dcr: true } });
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      error_description: 'Too many registration requests. Please try again later.',
    });
  }

  // Owner system user must be configured (fail-safe, not crash).
  const ownerUserId = env.OAUTH_DCR_OWNER_USER_ID;
  if (!ownerUserId) {
    return error(
      res,
      503,
      'temporarily_unavailable',
      'Dynamic client registration is not currently available.'
    );
  }

  // Parse + validate metadata.
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return error(
      res,
      400,
      'invalid_client_metadata',
      'Invalid registration metadata: ' + parsed.error.issues.map((i) => i.message).join('; ')
    );
  }
  const meta = parsed.data;

  // --- redirect_uri allowlist (RFC 7591 invalid_redirect_uri on violation) ---
  for (const uri of meta.redirect_uris) {
    if (!isAllowedDcrRedirectUri(uri)) {
      return error(
        res,
        400,
        'invalid_redirect_uri',
        `redirect_uri not allowed: ${uri}. Only https URLs or http loopback (127.0.0.1, [::1], localhost) are permitted.`
      );
    }
  }

  // --- grant_types: force public auth-code + refresh; reject client_credentials ---
  if (meta.grant_types) {
    const requested = new Set(meta.grant_types);
    if (requested.has('client_credentials') || requested.has('password')) {
      return error(
        res,
        400,
        'invalid_client_metadata',
        'Only authorization_code and refresh_token grants are supported for dynamic registration.'
      );
    }
    for (const g of requested) {
      if (g !== 'authorization_code' && g !== 'refresh_token') {
        return error(res, 400, 'invalid_client_metadata', `Unsupported grant_type: ${g}`);
      }
    }
  }

  // --- token_endpoint_auth_method: must be 'none' (public). ---
  if (meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== 'none') {
    return error(
      res,
      400,
      'invalid_client_metadata',
      "token_endpoint_auth_method must be 'none' (confidential clients are not supported via dynamic registration)."
    );
  }

  // --- response_types: only 'code'. ---
  if (meta.response_types) {
    for (const rt of meta.response_types) {
      if (rt !== 'code') {
        return error(res, 400, 'invalid_client_metadata', `Unsupported response_type: ${rt}`);
      }
    }
  }

  // --- scope: parse canonical names, reject unknown, then clamp to cap ---
  let requestedMask: number;
  if (meta.scope != null && meta.scope.trim() !== '') {
    const names = meta.scope.trim().split(/\s+/);
    const unknown = names.filter((n) => tokenScopeNameToFlag[n] == null);
    if (unknown.length > 0) {
      return error(res, 400, 'invalid_client_metadata', `Unknown scope(s): ${unknown.join(', ')}`);
    }
    requestedMask = scopeNamesToBitmask(names);
  } else {
    requestedMask = TokenScopePresets.MCPDefault;
  }

  // Hard cap: clamp to MCP-safe mask. UserRead is always present as a baseline.
  const cappedMask = (requestedMask & TokenScopePresets.MCPMaxAllowed) | TokenScope.UserRead;
  const grantedScopeNames = bitmaskToScopeNames(cappedMask);

  // Confirm the owner exists (cheap guard against a misconfigured env pointing
  // at a deleted user — would otherwise FK-fail on insert).
  const owner = await dbRead.user.findUnique({
    where: { id: ownerUserId },
    select: { id: true },
  });
  if (!owner) {
    return error(
      res,
      503,
      'temporarily_unavailable',
      'Dynamic client registration is not currently available.'
    );
  }

  try {
    const result = await createOauthClient({
      userId: ownerUserId,
      name: meta.client_name ?? 'Unnamed Application',
      description: '',
      redirectUris: meta.redirect_uris,
      // Public client: rely on the redirect-derived origins for the (rarely
      // used) browser SPA case. Native/loopback clients send no Origin.
      allowedOrigins: [],
      isConfidential: false,
      allowedScopes: cappedMask,
      grants: [...DCR_GRANTS],
      isDynamicallyRegistered: true,
      logoUrl: meta.logo_uri ?? null,
    });

    logOAuthEvent({
      type: 'client.created',
      userId: ownerUserId,
      clientId: result.clientId,
      scope: cappedMask,
      ip,
      metadata: { dcr: true },
    });

    // RFC 7591 §3.2.1 client information response.
    return res.status(201).json({
      client_id: result.clientId,
      // No client_secret — public client.
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: meta.client_name ?? 'Unnamed Application',
      redirect_uris: result.redirectUris,
      grant_types: result.grants,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: grantedScopeNames.join(' '),
    });
  } catch (err: any) {
    console.error('[oauth/register] failed:', err);
    return error(res, 500, 'server_error', 'Failed to register client.');
  }
}
