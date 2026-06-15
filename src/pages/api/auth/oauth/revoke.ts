import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { timingSafeEqual } from 'crypto';
import requestIp from 'request-ip';
import { dbRead, dbWrite } from '~/server/db/client';
import { generateSecretHash } from '~/server/utils/key-generator';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  // Preflight stays permissive — we can't classify the caller until we see the
  // client_id on the actual POST.
  if (req.method === 'OPTIONS') {
    const shouldStop = addCorsHeaders(req, res, ['POST']);
    if (shouldStop) return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, token_type_hint, client_id, client_secret } = req.body;
  const ip = requestIp.getClientIp(req) ?? 'unknown';

  // Rate-limit by IP before any DB work so a malicious origin can't drive cost
  // via repeated lookups + audit-log writes.
  const allowed = await checkOAuthRateLimit(req, res, 'revoke', ip);
  if (!allowed) return sendRateLimitResponse(res);

  // Single lookup covers both origin enforcement (public clients) and secret
  // validation (confidential clients without an authenticated session).
  const client =
    typeof client_id === 'string'
      ? await dbRead.oauthClient.findUnique({
          where: { id: client_id },
          select: {
            id: true,
            userId: true,
            secret: true,
            isConfidential: true,
            allowedOrigins: true,
          },
        })
      : null;

  // Public clients with an Origin header must match the registered allowlist.
  // A missing Origin is allowed (native/mobile public clients don't send
  // one); same policy as oauthModel.getClient on /token. Defense-in-depth:
  // we check `client.allowedOrigins.includes(origin)` here too — the echo
  // below should never go out for an unverified origin.
  if (client && !client.isConfidential && origin) {
    if (!client.allowedOrigins.includes(origin)) {
      logOAuthEvent({
        type: 'origin.rejected',
        clientId: client.id,
        ip,
        metadata: { origin, endpoint: 'revoke' },
      });
      return res.status(403).json({
        error: 'origin_not_allowed',
        error_description:
          'Origin is not in the registered allowedOrigins for this client.',
      });
    }
    // Per-origin CORS for approved public-client browser callers. No
    // Allow-Credentials — public clients use Bearer tokens, not cookies.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
  } else {
    // Confidential, unknown, or no-Origin (native) caller — keep wildcard
    // CORS. Native callers ignore CORS; browser callers without an Origin
    // header are non-XHR and don't read response headers anyway.
    addCorsHeaders(req, res, ['POST']);
  }

  if (!token) {
    return res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'Missing token parameter' });
  }

  // Authenticate the caller — require either a valid session or client credentials.
  const session = await getServerAuthSession({ req, res });
  let authenticatedUserId: number | null = session?.user?.id ?? null;

  if (
    !authenticatedUserId &&
    client?.isConfidential &&
    client.secret &&
    client_secret
  ) {
    const hashedSecret = generateSecretHash(client_secret);
    if (timingSafeEqual(Buffer.from(hashedSecret), Buffer.from(client.secret))) {
      authenticatedUserId = client.userId;
    }
  }

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
