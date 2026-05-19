import type { NextApiRequest, NextApiResponse } from 'next';
import { Request, Response } from '@node-oauth/oauth2-server';
import requestIp from 'request-ip';
import { oauthServer } from '~/server/oauth/server';
import { dbRead } from '~/server/db/client';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { ACCESS_TOKEN_TTL } from '~/server/oauth/constants';

/**
 * Set per-origin CORS headers for a validated public client. Public clients
 * have no client_secret, so the browser Origin is the only signal that lets
 * us refuse a code-exchange attempt from an unregistered site after a code
 * has been intercepted. The wildcard CORS we use for confidential clients
 * would defeat that, hence the explicit echo here.
 */
function setPublicClientCors(req: NextApiRequest, res: NextApiResponse, origin: string) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  // The token endpoint is called from third-party origins. For confidential
  // clients we keep the existing wildcard CORS — `client_secret` is the auth
  // boundary, the browser can't see it, and any extra browser-side restriction
  // would just break legitimate server-to-server callers that still happen to
  // send an Origin. For public clients we replace `*` with the validated
  // Origin so the browser refuses cross-origin token exchanges that don't
  // match the registered allowlist.
  //
  // We can't know confidential-vs-public until we've looked up the client by
  // id, which we can only do for the actual POST (the preflight has no body).
  // So preflight stays permissive; the real request does the per-client work
  // below.
  if (req.method === 'OPTIONS') {
    const shouldStop = addCorsHeaders(req, res, ['POST']);
    if (shouldStop) return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId = req.body?.client_id ?? 'unknown';
  const ip = requestIp.getClientIp(req) ?? '';

  // Rate limit by client_id (runs before the origin check so a malicious
  // origin can't bypass the limiter by being rejected early).
  const allowed = await checkOAuthRateLimit(req, res, 'token', clientId);
  if (!allowed) return sendRateLimitResponse(res);

  // Look up the client up front so we can tailor CORS + origin enforcement
  // to its type. A miss here falls through to oauthServer.token which will
  // produce the canonical `invalid_client` error.
  let isConfidential = true;
  if (typeof clientId === 'string' && clientId !== 'unknown') {
    const client = await dbRead.oauthClient.findUnique({
      where: { id: clientId },
      select: { id: true, isConfidential: true, allowedOrigins: true },
    });
    if (client) {
      isConfidential = client.isConfidential;
      if (!client.isConfidential) {
        if (!origin || !client.allowedOrigins.includes(origin)) {
          logOAuthEvent({
            type: 'origin.rejected',
            clientId: client.id,
            ip,
            metadata: { origin: origin ?? null, endpoint: 'token' },
          });
          // No CORS headers on rejection — the browser will surface a network
          // error to the offending page rather than a structured 403, which is
          // the intended UX for an unregistered origin.
          return res.status(403).json({
            error: 'origin_not_allowed',
            error_description:
              'Origin is not in the registered allowedOrigins for this client.',
          });
        }
        // Per-origin CORS for approved public clients.
        setPublicClientCors(req, res, origin);
      }
    }
  }

  // Confidential clients (or unknown client_id — let the OAuth server emit
  // the canonical error) keep the existing wildcard CORS behaviour.
  if (isConfidential) {
    addCorsHeaders(req, res, ['POST']);
  }

  try {
    const request = new Request({
      method: req.method,
      headers: req.headers as Record<string, string>,
      query: req.query as Record<string, string>,
      body: req.body,
    });

    const response = new Response(res);

    const token = await oauthServer.token(request, response);

    const grantType = req.body?.grant_type;
    logOAuthEvent({
      type: grantType === 'refresh_token' ? 'token.refreshed' : 'token.issued',
      userId: typeof token.user?.id === 'number' ? token.user.id : undefined,
      clientId,
      scope: token.scope
        ? parseInt(Array.isArray(token.scope) ? token.scope[0] : token.scope, 10)
        : undefined,
      ip,
    });

    return res.status(200).json({
      access_token: token.accessToken,
      token_type: 'Bearer',
      expires_in: token.accessTokenLifetime ?? ACCESS_TOKEN_TTL,
      refresh_token: token.refreshToken,
      scope: token.scope,
    });
  } catch (err: any) {
    const status = err.statusCode || err.code || 500;
    return res.status(typeof status === 'number' ? status : 500).json({
      error: err.name || 'server_error',
      error_description: err.message,
    });
  }
}
