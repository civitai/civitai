import { createKyselyClients } from '@civitai/db/kysely';
import { updatedAtPlugin } from '@civitai/db-queries';
import type { DB } from '@civitai/db-schema/kysely';
import { UPDATED_AT_TABLES } from '@civitai/db-schema/kysely/updated-at-tables';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { datapacketDbRead } from '~/server/db/datapacketDb';

// Kysely clients over the app's EXISTING pg pools (pgDb / datapacketDb) — no new pools, no new connections.
// @civitai/db-queries functions take a client as their first argument (executor injection); these are the
// clients callers pass in. Prisma stays the schema/migration source of truth and the Kysely type generator;
// this is queries only. Pass `kyselyWrite` (or an open transaction from it) to compose statements atomically;
// use `getKyselyWithoutLag` (db-lag-helpers) to pick the read-your-writes-correct client for read paths.
//
// updatedAtPlugin auto-stamps `updatedAt = <now>` on every UPDATE to a table that has a Prisma `@updatedAt`
// column (the set is generated from the schema), so ported writes don't have to set it by hand. A write that
// must NOT bump it opts out with `db.withoutPlugins()` or by writing the column to itself
// (`set({ updatedAt: sql`"updatedAt"` })`); raw `sql` UPDATEs are never rewritten.
const plugins = [updatedAtPlugin(UPDATED_AT_TABLES)];

const { dbRead, dbWrite } = createKyselyClients<DB>({
  pool: pgDbWrite,
  readPool: pgDbRead,
  plugins,
});

export const kyselyRead = dbRead;
export const kyselyWrite = dbWrite;
// Main-app-only tiers. Available for dynamic per-call routing (long-running reads, the datapacket replica).
// Read-only replicas — no UPDATEs run here, so they don't need the plugin.
export const kyselyReadLong = createKyselyClients<DB>({
  pool: pgDbReadLong,
  singleClient: true,
}).db;
export const kyselyDatapacket = createKyselyClients<DB>({
  pool: datapacketDbRead,
  singleClient: true,
}).db;
