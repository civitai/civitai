import { dbRead } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  readUserBannedAtViaKysely,
  readUserBannedAtViaPrisma,
} from '~/server/services/hot-reads-6.reads';

/** A user's `bannedAt` by username, on the replica, or `null` for no such user. */
export async function getUserBannedAtByUsername(username: string) {
  if (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_6))
    return readUserBannedAtViaKysely((await loadKyselyDb()).kyselyRead, username);
  return readUserBannedAtViaPrisma(dbRead, username);
}
