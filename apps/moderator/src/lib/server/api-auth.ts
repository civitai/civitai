import { error } from '@sveltejs/kit';
import { createSessionClient, type SessionUser } from '@civitai/auth';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { env } from '$env/dynamic/private';
import { dbRead, dbWrite } from './db';

// Resolve a Civitai API key into the same rich SessionUser the cookie path produces, so an agent acts
// AS a person and inherits that person's roles. No lab-specific credential exists, and none should:
// revoking the mod role has to be enough to end agent access, and every write needs a nameable human
// behind it.

const LAST_USED_DEBOUNCE_MS = 60 * 60 * 1000;

const sessions = createSessionClient();

export async function userFromApiKey(rawKey: string): Promise<SessionUser | null> {
  const key = rawKey.trim();
  if (!key) return null;

  // Said out loud rather than left to the hash to throw. Without the salt every valid key hashes to
  // something that matches no row, so the failure would present as "your key is wrong" — for everyone,
  // forever, with nothing in the logs pointing at the deployment.
  if (!env.NEXTAUTH_SECRET) {
    error(500, 'NEXTAUTH_SECRET is not configured, so API-key authentication is unavailable here.');
  }

  const hash = generateSecretHash(key);
  const now = new Date();

  const row = await dbRead
    .selectFrom('ApiKey')
    .select(['id', 'userId', 'lastUsedAt', 'clientId'])
    .where('key', '=', hash)
    .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>=', now)]))
    .executeTakeFirst();
  if (!row) return null;

  // OAuth access tokens live in the same table with a `clientId`. A user consenting to some third-party
  // app must not thereby hand that app moderator tooling, so only personal keys are accepted here.
  if (row.clientId) return null;

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    dbWrite
      .updateTable('ApiKey')
      .set({ lastUsedAt: now })
      .where('id', '=', row.id)
      .execute()
      .catch(() => {});
  }

  const user = await sessions.getSessionUserById(row.userId);
  if (!user) return null;
  // A ban leaves the row intact so the cookie path can render a "you're banned" page; the key path has
  // no such page and must reject outright.
  if (user.bannedAt) return null;

  return user;
}

/** Pull the key out of an `Authorization: Bearer <key>` header. Null when the header is absent or another scheme. */
export function bearerKey(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || null : null;
}
