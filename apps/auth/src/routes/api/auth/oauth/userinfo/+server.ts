import { json, type RequestHandler } from '@sveltejs/kit';
import { TokenScope } from '@civitai/auth/token-scope';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { db } from '$lib/server/db/db';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { hasScope } from '$lib/server/oauth/scope';
import { setWildcardCors } from '$lib/server/oauth/http';

// GET /api/auth/oauth/userinfo — OIDC UserInfo (OIDC Core §5.1). Ported from
// src/pages/api/auth/oauth/userinfo.ts; the hub validates the Bearer token directly against ApiKey
// (same SHA512 hash as the main app's bearer path) instead of getSessionFromBearerToken, then resolves
// the rich user from the shared session cache. Gated on the UserRead scope bit.

export const OPTIONS: RequestHandler = () => {
  const headers = new Headers();
  setWildcardCors(headers, 'GET');
  return new Response(null, { status: 204, headers });
};

export const GET: RequestHandler = async ({ request }) => {
  const headers = new Headers();
  setWildcardCors(headers, 'GET');

  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return json({ error: 'invalid_token', error_description: 'Missing bearer token' }, { status: 401, headers });
  }

  const hash = generateSecretHash(auth.slice(7));
  const now = new Date();
  const apiKey = await db
    .selectFrom('ApiKey')
    .select(['userId', 'tokenScope'])
    .where('key', '=', hash)
    .where('type', '=', 'Access')
    .where((eb) => eb.or([eb('expiresAt', '>=', now), eb('expiresAt', 'is', null)]))
    .executeTakeFirst();

  if (!apiKey) {
    return json({ error: 'invalid_token', error_description: 'Invalid or expired token' }, { status: 401, headers });
  }

  // Requires UserRead (fail-safe: deny if the bit is missing).
  if (!hasScope(apiKey.tokenScope, TokenScope.UserRead)) {
    return json(
      { error: 'insufficient_scope', error_description: 'Token does not have UserRead scope' },
      { status: 403, headers }
    );
  }

  const user = await getOrProduceSessionUser(apiKey.userId).catch(() => null);
  if (!user) {
    return json({ error: 'invalid_token', error_description: 'Invalid or expired token' }, { status: 401, headers });
  }

  // `name`/`preferred_username` intentionally mirror the username rather than the display name — the
  // display name is provider-ingested PII we don't hand to third-party apps. email/email_verified are
  // released under the same UserRead scope (the consent "Read profile & settings" permission).
  return json(
    {
      sub: user.id.toString(),
      id: user.id,
      username: user.username,
      preferred_username: user.username ?? undefined,
      name: user.username ?? undefined,
      picture: user.image ?? undefined,
      image: user.image,
      ...(user.email ? { email: user.email, email_verified: !!user.emailVerified } : {}),
    },
    { headers }
  );
};
