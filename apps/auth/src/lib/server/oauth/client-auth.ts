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
 * Only for decisions made before the OAuth library runs (rate-limit bucketing); the library still
 * authenticates the client itself for the grant.
 */
export async function authenticatedConfidentialClient(
  request: Request,
  body: Record<string, unknown>
): Promise<{ id: string; tokenRateLimit: number | null } | null> {
  const basic = basicCredentials(request);
  const clientId = basic?.id ?? (typeof body.client_id === 'string' ? body.client_id : '');
  const clientSecret =
    basic?.secret ?? (typeof body.client_secret === 'string' ? body.client_secret : '');
  if (!clientId || !clientSecret) return null;

  const client = await db
    .selectFrom('OauthClient')
    .select(['id', 'secret', 'isConfidential', 'tokenRateLimit', 'userId'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!client?.isConfidential || !client.secret) return null;

  const provided = Buffer.from(generateSecretHash(clientSecret));
  const stored = Buffer.from(client.secret);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) return null;
  const tokenRateLimit = client.userId === SYSTEM_USER_ID ? client.tokenRateLimit : null;
  return { id: client.id, tokenRateLimit };
}
