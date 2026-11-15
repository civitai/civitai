import { timingSafeEqual } from 'crypto';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { db } from '$lib/server/db/db';
import { basicCredentials } from '$lib/server/oauth/http';
import { SYSTEM_USER_ID } from '$lib/server/oauth/constants';

/**
 * The confidential client this request authenticates as (Basic header, else body client_id/client_secret),
 * with its staff-set token limit (honoured only while it is a system app), or null. Checked the way introspect checks it: the stored secret is a
 * hash, compared in constant time, and a length mismatch (a legacy/plaintext secret) fails closed.
 *
 * The token route uses it for rate-limit bucketing before the library authenticates the client; the user
 * token exchange and introspection of its JWTs use it as their client authentication.
 */
export async function authenticatedConfidentialClient(
  request: Request,
  body: Record<string, unknown>
): Promise<{ id: string; tokenRateLimit: number | null; accessMode: string } | null> {
  const basic = basicCredentials(request);
  const clientId = basic?.id ?? (typeof body.client_id === 'string' ? body.client_id : '');
  const clientSecret =
    basic?.secret ?? (typeof body.client_secret === 'string' ? body.client_secret : '');
  if (!clientId || !clientSecret) return null;

  const client = await db
    .selectFrom('OauthClient')
    .select(['id', 'secret', 'isConfidential', 'tokenRateLimit', 'userId', 'accessMode'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!client?.isConfidential || !client.secret) return null;

  const provided = Buffer.from(generateSecretHash(clientSecret));
  const stored = Buffer.from(client.secret);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) return null;
  const tokenRateLimit = client.userId === SYSTEM_USER_ID ? client.tokenRateLimit : null;
  return { id: client.id, tokenRateLimit, accessMode: client.accessMode };
}

/** The client id in a Basic Authorization header, parsed as the OAuth library's `basic-auth` dependency parses it. */
export function basicAuthClientId(header: string | null): string | undefined {
  const match = /^ *(?:[Bb][Aa][Ss][Ii][Cc]) +([A-Za-z0-9._~+/-]+=*) *$/.exec(header ?? '');
  if (!match) return undefined;
  return /^([^:]*):(.*)$/.exec(Buffer.from(match[1], 'base64').toString())?.[1];
}

/**
 * Whether the body names a `client_id` other than `basicClientId`, the id the caller's client
 * authentication reads from the Basic header (undefined: no Basic header).
 */
export function clientIdMismatch(
  basicClientId: string | undefined,
  body: Record<string, unknown>
): boolean {
  return basicClientId !== undefined && !!body.client_id && body.client_id !== basicClientId;
}
