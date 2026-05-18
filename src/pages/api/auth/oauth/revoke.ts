import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import requestIp from 'request-ip';
import { dbRead, dbWrite } from '~/server/db/client';
import { generateSecretHash } from '~/server/utils/key-generator';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  // Preflights stay permissive — we can't know whether the caller is public
  // or confidential until we see the client_id on the actual POST.
  if (req.method === 'OPTIONS') {
    const shouldStop = addCorsHeaders(req, res, ['POST']);
    if (shouldStop) return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, token_type_hint, client_id, client_secret } = req.body;

  // Mirror the token endpoint: public clients must come from a registered
  // origin. Confidential clients keep the existing wildcard CORS.
  let isConfidentialClient = true;
  if (typeof client_id === 'string') {
    const lookedUp = await dbRead.oauthClient.findUnique({
      where: { id: client_id },
      select: { id: true, isConfidential: true, allowedOrigins: true },
    });
    if (lookedUp) {
      isConfidentialClient = lookedUp.isConfidential;
      if (!lookedUp.isConfidential) {
        if (!origin || !lookedUp.allowedOrigins.includes(origin)) {
          logOAuthEvent({
            type: 'origin.rejected',
            clientId: lookedUp.id,
            ip: requestIp.getClientIp(req) ?? undefined,
            metadata: { origin: origin ?? null, endpoint: 'revoke' },
          });
          return res.status(403).json({
            error: 'origin_not_allowed',
            error_description:
              'Origin is not in the registered allowedOrigins for this client.',
          });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
      }
    }
  }
  if (isConfidentialClient) {
    addCorsHeaders(req, res, ['POST']);
  }

  if (!token) {
    return res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'Missing token parameter' });
  }

  // Authenticate the caller — require either a valid session or client credentials
  const session = await getServerAuthSession({ req, res });
  let authenticatedUserId: number | null = session?.user?.id ?? null;

  // If no session, require client_id + client_secret
  if (!authenticatedUserId && client_id) {
    const client = await dbWrite.oauthClient.findUnique({
      where: { id: client_id },
      select: { userId: true, secret: true, isConfidential: true },
    });
    if (client?.isConfidential && client.secret && client_secret) {
      const hashedSecret = generateSecretHash(client_secret);
      if (timingSafeEqual(Buffer.from(hashedSecret), Buffer.from(client.secret))) {
        authenticatedUserId = client.userId;
      }
    }
  }

  // Rate limit by IP (not client_id, to prevent bypass)
  const ip = requestIp.getClientIp(req) ?? 'unknown';
  const allowed = await checkOAuthRateLimit(req, res, 'revoke', ip);
  if (!allowed) return sendRateLimitResponse(res);

  try {
    const hash = generateSecretHash(token);

    const types =
      token_type_hint === 'refresh_token'
        ? ['Refresh' as const, 'Access' as const]
        : ['Access' as const, 'Refresh' as const];

    for (const type of types) {
      const apiKey = await dbWrite.apiKey.findFirst({
        where: { key: hash, type },
        select: { id: true, clientId: true, userId: true, type: true },
      });

      if (apiKey) {
        // Must be authenticated to revoke tokens
        if (!authenticatedUserId) {
          break; // Silently ignore per RFC 7009 — don't reveal token existence
        }
        // Can only revoke your own tokens
        if (apiKey.userId !== authenticatedUserId) {
          break; // Silently ignore per RFC 7009
        }

        logOAuthEvent({
          type: 'token.revoked',
          userId: apiKey.userId,
          clientId: apiKey.clientId ?? undefined,
          ip,
        });

        await dbWrite.apiKey.delete({ where: { id: apiKey.id } });

        if (apiKey.type === 'Refresh' && apiKey.clientId) {
          await dbWrite.apiKey.deleteMany({
            where: {
              clientId: apiKey.clientId,
              userId: apiKey.userId,
              type: 'Access',
            },
          });
        }
        break;
      }
    }

    // Per RFC 7009: always return 200
    return res.status(200).json({});
  } catch {
    return res.status(200).json({});
  }
}
