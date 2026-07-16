import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { datapacketDbRead } from '~/server/db/datapacketDb';

// Kysely clients over the app's EXISTING pg pools (pgDb / datapacketDb) — no new pools, no new connections.
// @civitai/db-queries functions take a client as their first argument (executor injection); these are the
// clients callers pass in. Prisma stays the schema/migration source of truth and the Kysely type generator;
// this is queries only. Pass `kyselyWrite` (or an open transaction from it) to compose statements atomically;
// use `getKyselyWithoutLag` (db-lag-helpers) to pick the read-your-writes-correct client for read paths.
const { dbRead, dbWrite } = createKyselyClients<DB>({ pool: pgDbWrite, readPool: pgDbRead });

export const kyselyRead = dbRead;
export const kyselyWrite = dbWrite;
// Main-app-only tiers. Available for dynamic per-call routing (long-running reads, the datapacket replica).
export const kyselyReadLong = createKyselyClients<DB>({
  pool: pgDbReadLong,
  singleClient: true,
}).db;
export const kyselyDatapacket = createKyselyClients<DB>({
  pool: datapacketDbRead,
  singleClient: true,
}).db;
