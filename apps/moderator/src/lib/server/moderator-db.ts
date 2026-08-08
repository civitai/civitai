import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { ModeratorDB } from './moderator-db-types';

// The MODERATOR database — moderation data that has never lived in Civitai's Postgres: user notes,
// strikes, timed mutes, image help requests. Separate from `db.ts`, which is the main app's database.
//
// A single read-write client, not the read/replica pair: this data is small, written by the same people
// reading it, and every flow here is read-your-writes (add a note → see it immediately). A replica would
// only introduce lag.
//
// In development this points at Retool's own database so the existing data is usable while the tooling
// is built; later it moves to a dedicated moderator database. Nothing in the app should care which —
// that is the point of routing every access through this module and `ModeratorDB`.
//
// Lazy: a missing MODERATOR_DATABASE_URL throws on first use, not at boot, so the rest of the app still
// runs for anyone who has not configured it.
let client: ReturnType<typeof createModeratorDb> | undefined;

function createModeratorDb() {
  const connectionString = env.MODERATOR_DATABASE_URL;
  if (!connectionString) throw new Error('MODERATOR_DATABASE_URL is not configured');
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
