import { json, type RequestHandler } from '@sveltejs/kit';
import { timingSafeEqual } from 'crypto';
import { env } from '$env/dynamic/private';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { db } from '$lib/server/db/db';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { basicCredentials, parseBody } from '$lib/server/oauth/http';
import { carriesClientCredentialsOnlyScope } from '$lib/server/oauth/scope';
import { getClientIp } from '$lib/server/auth/request';
import { authenticatedConfidentialClient } from '$lib/server/oauth/client-auth';
import {
  introspectAccessTokenJwt,
  isAccessTokenJwt,
  isAnyIntrospector,
} from '$lib/server/oauth/jwt-introspection';

// POST /api/auth/oauth/introspect — RFC 7662 token introspection.
//
// Access tokens are opaque (`civitai_` + 36 random chars, only the salted hash stored), so a
// first-party service that receives one cannot verify it offline. link-service is the caller:
// it introspects a Civitai Link client's token — the desktop app or the ComfyUI node pack — and
// requires the LinkConnect bit before minting an instance key. The orchestrator is the caller for
// `Worker` tokens, which it checks when a worker registers.
//
// NOT a public endpoint. The caller must be a CONFIDENTIAL client on OAUTH_INTROSPECTION_CLIENT_IDS
// (answered for user access tokens) or OAUTH_WORKER_INTROSPECTION_CLIENT_IDS (answered for `Worker`
// tokens); every other outcome is 401 invalid_client. A JWT from the user token exchange (`typ: at+jwt`)
// is answered instead for the introspectors its resource lists (lib/server/oauth/jwt-introspection.ts).
// Any token miss — unknown, expired, wrong type, absent, owned by a disabled account, a single-purpose client-credentials token, a blocked worker
// device, or a token kind this caller may not see — is 200 {active:false}, never a distinguishing error.

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Read per request, not at module load: the value must be settable between test cases. */
function clientIdList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await parseBody(request);
  const basic = basicCredentials(request);
  const clientId = basic?.id ?? (typeof body.client_id === 'string' ? body.client_id : '');
  const clientSecret =
    basic?.secret ?? (typeof body.client_secret === 'string' ? body.client_secret : '');

  const rateLimited = () => json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
  const invalidClient = () => json({ error: 'invalid_client' }, { status: 401, headers: NO_STORE });

  // Pre-auth work is charged per IP, never to the client id — that id is attacker-supplied until the
  // secret check below passes, so charging it here would let a flood against a guessed id exhaust the
  // real client's budget and block Link pairing.
  if (!(await checkOAuthRateLimit('introspect-anon', getClientIp(request)))) return rateLimited();

  const seesAccess = clientIdList(env.OAUTH_INTROSPECTION_CLIENT_IDS).has(clientId);
  const seesWorker = clientIdList(env.OAUTH_WORKER_INTROSPECTION_CLIENT_IDS).has(clientId);

  // A JWT from the user token exchange is answered for the introspectors its resource lists.
  const token = typeof body.token === 'string' ? body.token : '';
  if (token && isAccessTokenJwt(token)) {
    return introspectExchangedJwt(request, body, token, seesAccess || seesWorker);
  }

  if (!clientId || !clientSecret || (!seesAccess && !seesWorker)) return invalidClient();

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

  if (!(await checkOAuthRateLimit(seesWorker ? 'introspect-worker' : 'introspect', clientId))) {
    return rateLimited();
  }

  if (!token) return json({ active: false }, { headers: NO_STORE });

  const now = new Date();
  const hash = generateSecretHash(token);
  if (seesWorker) {
    const worker = await introspectWorkerToken(hash, now);
    if (worker) return json(worker, { headers: NO_STORE });
  }
  if (!seesAccess) return json({ active: false }, { headers: NO_STORE });

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
    .where('ApiKey.key', '=', hash)
    .where('ApiKey.type', '=', 'Access')
    .where((eb) => eb.or([eb('ApiKey.expiresAt', '>=', now), eb('ApiKey.expiresAt', 'is', null)]))
    // RFC 7662 scopes `active` to the token, but this answer is the sole authorization input a
    // first-party service has before it mints a durable credential of its own, so a disabled owner
    // must read as inactive here rather than downstream. Deletion is soft, so the join alone
    // catches nothing.
    .where('User.deletedAt', 'is', null)
    .where('User.bannedAt', 'is', null)
    .executeTakeFirst();

  // A client-credentials token is single-purpose, so it reads as inactive like an unknown one.
  if (!row || carriesClientCredentialsOnlyScope(row.tokenScope)) {
    return json({ active: false }, { headers: NO_STORE });
  }

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

/**
 * Introspection of an exchanged JWT. The caller authenticates as a confidential client and must be an
 * introspector of some resource, or on one of the introspection lists; anything else is invalid_client.
 * A token check that cannot be decided is a 503 the caller retries, never active. So is a client lookup
 * that fails before the caller is known: it says nothing about the token, and a 401 would read as a
 * bad secret.
 */
async function introspectExchangedJwt(
  request: Request,
  body: Record<string, unknown>,
  token: string,
  onIntrospectionList: boolean
): Promise<Response> {
  const unavailable = () =>
    json(
      { error: 'temporarily_unavailable' },
      { status: 503, headers: { ...NO_STORE, 'Retry-After': '5' } }
    );
  let client: Awaited<ReturnType<typeof authenticatedConfidentialClient>>;
  let introspector: boolean;
  try {
    client = await authenticatedConfidentialClient(request, body);
    introspector = client ? await isAnyIntrospector(client.id) : false;
  } catch {
    return unavailable();
  }
  if (!client || (!introspector && !onIntrospectionList)) {
    return json({ error: 'invalid_client' }, { status: 401, headers: NO_STORE });
  }
  if (!(await checkOAuthRateLimit('introspect-jwt', client.id))) {
    return json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
  }

  const result = await introspectAccessTokenJwt(token, client.id);
  if (result.kind === 'indeterminate') return unavailable();
  if (result.kind === 'inactive') return json({ active: false }, { headers: NO_STORE });
  return json(result.body, { headers: NO_STORE });
}

/**
 * The introspection body for a live `Worker` token, or null. Live: unexpired, its device not blocked, and
 * its client still a workload client.
 */
async function introspectWorkerToken(hash: string, now: Date) {
  const row = await db
    .selectFrom('ApiKey')
    .innerJoin('WorkerDevice', 'WorkerDevice.id', 'ApiKey.workerDeviceId')
    .innerJoin('WorkerClient', 'WorkerClient.clientId', 'ApiKey.clientId')
    .select([
      'ApiKey.tokenScope',
      'ApiKey.clientId',
      'ApiKey.expiresAt',
      'WorkerDevice.issuer',
      'WorkerDevice.subject',
      'WorkerClient.provider',
    ])
    .where('ApiKey.key', '=', hash)
    .where('ApiKey.type', '=', 'Worker')
    .where('ApiKey.expiresAt', '>=', now)
    .where('WorkerDevice.status', '=', 'active')
    .executeTakeFirst();
  if (!row?.expiresAt) return null;

  return {
    active: true,
    client_id: row.clientId ?? undefined,
    worker_provider: row.provider,
    device_id: row.subject,
    device_issuer: row.issuer,
    scope: String(row.tokenScope),
    exp: Math.floor(row.expiresAt.getTime() / 1000),
    token_type: 'Bearer',
  };
}
