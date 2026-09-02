import { json, type RequestHandler } from '@sveltejs/kit';
import { timingSafeEqual } from 'crypto';
import { env } from '$env/dynamic/private';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { db } from '$lib/server/db/db';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { parseBody } from '$lib/server/oauth/http';

// POST /api/auth/oauth/introspect — RFC 7662 token introspection.
//
// Access tokens are opaque (`civitai_` + 36 random chars, only the salted hash stored), so a
// first-party service that receives one cannot verify it offline. link-service is the caller:
// it introspects the Civitai Link desktop app's token and requires the LinkConnect bit before
// minting an instance key.
//
// NOT a public endpoint. The caller must be a CONFIDENTIAL client AND on the
// OAUTH_INTROSPECTION_CLIENT_IDS allowlist; every other outcome is 401 invalid_client. Any token
// miss — unknown, expired, wrong type, absent — is 200 {active:false}, never a distinguishing
// error. Server-to-server, so no CORS and no OPTIONS.

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Read per request, not at module load: the value must be settable between test cases. */
function allowedIntrospectionClients(): Set<string> {
  return new Set(
    (env.OAUTH_INTROSPECTION_CLIENT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/** RFC 6749 §2.3.1 form-urlencodes each half of a Basic credential. */
function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function basicCredentials(request: Request): { id: string; secret: string } | null {
  const header = request.headers.get('authorization') ?? '';
  if (!/^basic /i.test(header)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { id: formDecode(decoded.slice(0, sep)), secret: formDecode(decoded.slice(sep + 1)) };
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await parseBody(request);
  const basic = basicCredentials(request);
  const clientId = basic?.id ?? (typeof body.client_id === 'string' ? body.client_id : '');
  const clientSecret =
    basic?.secret ?? (typeof body.client_secret === 'string' ? body.client_secret : '');

  if (!(await checkOAuthRateLimit('introspect', clientId || null))) {
    return json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
  }

  const invalidClient = () => json({ error: 'invalid_client' }, { status: 401, headers: NO_STORE });

  if (!clientId || !clientSecret || !allowedIntrospectionClients().has(clientId)) {
    return invalidClient();
  }

  const client = await db
    .selectFrom('OauthClient')
    .select(['id', 'secret', 'isConfidential'])
    .where('id', '=', clientId)
    .executeTakeFirst();

  if (!client?.isConfidential || !client.secret) return invalidClient();

  const provided = Buffer.from(generateSecretHash(clientSecret));
  const stored = Buffer.from(client.secret);
  // Length guard — timingSafeEqual throws on a mismatch (a legacy/plaintext secret). Fail closed.
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
    return invalidClient();
  }

  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return json({ active: false }, { headers: NO_STORE });

  const now = new Date();
  const row = await db
    .selectFrom('ApiKey')
    .innerJoin('User', 'User.id', 'ApiKey.userId')
    .select([
      'ApiKey.userId',
      'ApiKey.tokenScope',
      'ApiKey.clientId',
      'ApiKey.expiresAt',
      'User.username',
    ])
    .where('ApiKey.key', '=', generateSecretHash(token))
    .where('ApiKey.type', '=', 'Access')
    .where((eb) => eb.or([eb('ApiKey.expiresAt', '>=', now), eb('ApiKey.expiresAt', 'is', null)]))
    .executeTakeFirst();

  if (!row) return json({ active: false }, { headers: NO_STORE });

  return json(
    {
      active: true,
      sub: String(row.userId),
      username: row.username,
      // Decimal bitmask string, not the RFC's space-separated list — this provider has no
      // string scope vocabulary (see lib/server/oauth/scope.ts).
      scope: String(row.tokenScope),
      client_id: row.clientId ?? undefined,
      ...(row.expiresAt ? { exp: Math.floor(row.expiresAt.getTime() / 1000) } : {}),
      token_type: 'Bearer',
    },
    { headers: NO_STORE }
  );
};
