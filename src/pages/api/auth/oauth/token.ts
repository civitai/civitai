import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { Request, Response } from '@node-oauth/oauth2-server';
import requestIp from 'request-ip';
import { oauthServer } from '~/server/oauth/server';
import { dbRead } from '~/server/db/client';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { OriginNotAllowedError } from '~/server/oauth/errors';
import { ACCESS_TOKEN_TTL } from '~/server/oauth/constants';

/**
 * Per-origin CORS for a validated public client. The browser Origin is the
 * only signal that lets us refuse a code-exchange attempt from an unregistered
 * site after a code has been intercepted, so the wildcard CORS we keep for
 * confidential clients would defeat that — hence the explicit echo here.
 *
 * No `Access-Control-Allow-Credentials`: public OAuth clients use Bearer
 * tokens, not cookies, and dropping it reduces the chance that civitai session
 * cookies are sent cross-origin if an SPA opts into `credentials: 'include'`.
 */
function setPublicClientCors(res: NextApiResponse, origin: string) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  // Preflight stays permissive — we can't classify confidential vs public
  // until we see the client_id on the actual POST.
  if (req.method === 'OPTIONS') {
    const shouldStop = addCorsHeaders(req, res, ['POST']);
    if (shouldStop) return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId = req.body?.client_id ?? 'unknown';
  const ip = requestIp.getClientIp(req) ?? '';
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  // Rate-limit by IP before any DB work. Keying on client_id would let an
  // attacker rotate through random ids to get a fresh bucket each request,
  // bypassing the limiter and driving unbounded model-layer lookups.
  const allowed = await checkOAuthRateLimit(req, res, 'token', ip || 'unknown');
  if (!allowed) return sendRateLimitResponse(res);

  const request = new Request({
    method: req.method,
    headers: req.headers as Record<string, string>,
    query: req.query as Record<string, string>,
    body: req.body,
  });
  const response = new Response(res);

  try {
    const token = await oauthServer.token(request, response);

    // `oauthModel.getClient` attaches the looked-up client to the Request so
    // the handler can drive CORS without a second DB lookup. If the stash is
    // missing on a successful token grant something has changed inside the
    // OAuth library (e.g. a new grant type that doesn't go through getClient
    // with our wiring), so fail-closed with a fallback lookup rather than
    // defaulting to wildcard CORS and risking a cross-origin leak of a
    // public-client token response.
    let attached = (request as Request & {
      oauthClient?: { id: string; isConfidential: boolean; allowedOrigins: string[] };
    }).oauthClient;
    if (!attached) {
      const fallback =
        typeof clientId === 'string' && clientId !== 'unknown'
          ? await dbRead.oauthClient.findUnique({
              where: { id: clientId },
              select: { id: true, isConfidential: true, allowedOrigins: true },
            })
          : null;
      attached = fallback ?? undefined;
    }
    // Defense-in-depth: only echo the request Origin when it's actually in
    // the client's allowlist. `oauthModel.getClient` already throws
    // OriginNotAllowedError on a mismatch, so on the normal success path this
    // is redundant — but if the fallback dbRead path runs (library wiring
    // change) or anything else slips through, we don't want to echo an
    // unverified origin and defeat the new pinning.
    if (
      attached &&
      !attached.isConfidential &&
      origin &&
      attached.allowedOrigins.includes(origin)
    ) {
      setPublicClientCors(res, origin);
    } else {
      addCorsHeaders(req, res, ['POST']);
    }

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
    if (err instanceof OriginNotAllowedError) {
      logOAuthEvent({
        type: 'origin.rejected',
        clientId: err.clientId,
        ip,
        metadata: { origin: err.origin ?? null, endpoint: 'token' },
      });
      // Intentionally no CORS on a rejected origin — the browser surfaces a
      // network error to the offending page rather than a structured 403,
      // which is the intended UX for unregistered origins.
      return res.status(403).json({
        error: 'origin_not_allowed',
        error_description: err.message,
      });
    }

    // Other errors (invalid_grant, invalid_client, server_error) — default to
    // wildcard CORS so confidential / unknown-client callers can read the
    // structured error body. Public clients lose the ability to read the body
    // cross-origin here, but error bodies don't leak token material.
    console.error('[oauth/token] handler error:', err);
    addCorsHeaders(req, res, ['POST']);
    const status = err.statusCode || err.code || 500;
    return res.status(typeof status === 'number' ? status : 500).json({
      error: err.name || 'server_error',
      error_description: err.message,
    });
  }
}
