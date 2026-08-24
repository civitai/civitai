import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { DB as ModeratorDB } from './moderator-db/types';

// User notes, strikes and image help requests — moderation data that never lived in the main database.
//
// ONE connection. `RETOOL_DATABASE_URL` and `MODERATOR_DATABASE_URL` used to name different instances,
// and this file carried a warning that pointing both at one database aimed these tables at the XGuard
// lab. That is over: the tables now live beside the lab in a single database, so `MODERATOR_DATABASE_URL`
// is the only name and `RETOOL_DATABASE_URL` is retired.
//
// Read-your-writes throughout, so a single read-write client rather than the read/replica pair in db.ts.
let client: ReturnType<typeof createModeratorDb> | undefined;

function createModeratorDb() {
  const connectionString = env.MODERATOR_DATABASE_URL;
  if (!connectionString) throw new Error('MODERATOR_DATABASE_URL is not configured');
  const { db } = createKyselyClients<ModeratorDB>({
    connectionString,
    singleClient: true,
    // The host presents a cert this chain does not verify; encrypted, unverified.
    sslNoVerify: true,
  });
  return db;
}

export function getModeratorDb() {
  if (!client) client = createModeratorDb();
  return client;
}
