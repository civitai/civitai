import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { readUserBannedAtViaKysely } from '~/server/services/hot-reads-6.reads';

/** A user's `bannedAt` by username, on the replica, or `null` for no such user. */
export async function getUserBannedAtByUsername(username: string) {
  return readUserBannedAtViaKysely((await loadKyselyDb()).kyselyRead, username);
}
