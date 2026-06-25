import { json, type RequestHandler } from '@sveltejs/kit';
import { timingSafeEqual } from 'crypto';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { db } from '$lib/server/db/db';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { parseBody, setWildcardCors, setPublicClientCors } from '$lib/server/oauth/http';

// POST /api/auth/oauth/revoke — RFC 7009 token revocation. Ported from src/pages/api/auth/oauth/revoke.ts.
// Session-cookie OR client-secret auth; ALWAYS returns 200 (even for unknown/expired tokens — never
// reveal token existence). The session is the hub's locals.user (hooks.server.ts) instead of
// getServerAuthSession.
//
// This is where the (user, client) ACCESS-token cascade lives: explicit revocation is the intended place
// to wipe all of an app's access for the user. Routine refresh rotation no longer cascades — see
// model.ts revokeToken and §D.x (resolved 2026-06-19).

export const OPTIONS: RequestHandler = () => {
  const headers = new Headers();
  setWildcardCors(headers);
  return new Response(null, { status: 204, headers });
};

export const POST: RequestHandler = async ({ request, getClientAddress, locals }) => {
  const body = await parseBody(request);
  const { token, token_type_hint, client_id, client_secret } = body;
  const ip = getClientAddress() || 'unknown';
  const origin = request.headers.get('origin') ?? undefined;

  // Rate-limit by IP before any DB work.
  if (!(await checkOAuthRateLimit('revoke', ip))) {
    const headers = new Headers();
    setWildcardCors(headers);
    return json({ error: 'rate_limited' }, { status: 429, headers });
  }

  // Single lookup covers origin enforcement (public clients) + secret validation (confidential clients).
  const client =
    typeof client_id === 'string'
      ? await db
          .selectFrom('OauthClient')
          .select(['id', 'userId', 'secret', 'isConfidential', 'allowedOrigins'])
          .where('id', '=', client_id)
          .executeTakeFirst()
      : undefined;

  const headers = new Headers();
  // Public clients sending an Origin must match the allowlist; a missing Origin is allowed (native).
  if (client && !client.isConfidential && origin) {
    if (!client.allowedOrigins.includes(origin)) {
      logOAuthEvent({ type: 'origin.rejected', clientId: client.id, ip, metadata: { origin, endpoint: 'revoke' } });
      return json(
        {
          error: 'origin_not_allowed',
          error_description: 'Origin is not in the registered allowedOrigins for this client.',
        },
        { status: 403 }
      );
    }
    setPublicClientCors(headers, origin);
  } else {
    setWildcardCors(headers);
  }

  if (!token) {
    return json({ error: 'invalid_request', error_description: 'Missing token parameter' }, { status: 400, headers });
  }

  // Authenticate: a valid session OR matching client credentials.
  let authenticatedUserId: number | null = locals.user?.id ?? null;
  if (!authenticatedUserId && client?.isConfidential && client.secret && client_secret) {
    const a = Buffer.from(generateSecretHash(client_secret));
    const b = Buffer.from(client.secret);
    // Length guard — timingSafeEqual throws on a length mismatch (a legacy/plaintext secret). Fail closed.
    if (a.length === b.length && timingSafeEqual(a, b)) {
      authenticatedUserId = client.userId;
    }
  }

  try {
    const hash = generateSecretHash(token);
    const types =
      token_type_hint === 'refresh_token'
        ? (['Refresh', 'Access'] as const)
        : (['Access', 'Refresh'] as const);

    for (const type of types) {
      const apiKey = await db
        .selectFrom('ApiKey')
        .select(['id', 'clientId', 'userId', 'type'])
        .where('key', '=', hash)
        .where('type', '=', type)
        .executeTakeFirst();

      if (apiKey) {
        // Must be authenticated, and can only revoke your own tokens. Silently ignore otherwise (RFC 7009
        // — don't reveal token existence).
        if (!authenticatedUserId || apiKey.userId !== authenticatedUserId) break;

        logOAuthEvent({
          type: 'token.revoked',
          userId: apiKey.userId,
          clientId: apiKey.clientId ?? undefined,
          ip,
        });

        await db.deleteFrom('ApiKey').where('id', '=', apiKey.id).execute();

        // Explicit revocation cascade: revoking a refresh token removes every access token for this
        // (user, client). This is the intended "remove this app's access" semantic (cf. routine rotation).
        if (apiKey.type === 'Refresh' && apiKey.clientId) {
          await db
            .deleteFrom('ApiKey')
            .where('clientId', '=', apiKey.clientId)
            .where('userId', '=', apiKey.userId)
            .where('type', '=', 'Access')
            .execute();
        }
        break;
      }
    }

    return json({}, { status: 200, headers });
  } catch {
    return json({}, { status: 200, headers });
  }
};
