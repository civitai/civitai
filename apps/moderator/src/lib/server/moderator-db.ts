import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { ModeratorDB } from './moderator-db-types';

// User notes, strikes, timed mutes and image help requests — still in Retool's own database, which is
// why this reads RETOOL_DATABASE_URL and not MODERATOR_DATABASE_URL. Those name different instances:
// pointing both at one database aims these tables at the XGuard lab, where they do not exist. They
// collapse into a single var only once the tables migrate.
//
// Read-your-writes throughout, so a single read-write client rather than the read/replica pair in db.ts.
let client: ReturnType<typeof createModeratorDb> | undefined;

function createModeratorDb() {
  const connectionString = env.RETOOL_DATABASE_URL;
  if (!connectionString) throw new Error('RETOOL_DATABASE_URL is not configured');
  const { db } = createKyselyClients<ModeratorDB>({
    connectionString,
    singleClient: true,
    // Retool's Postgres presents a cert this chain does not verify; encrypted, unverified.
    sslNoVerify: true,
  });
  return db;
}

export function getModeratorDb() {
  if (!client) client = createModeratorDb();
  return client;
}
