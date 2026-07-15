import { createKyselyClients } from '@civitai/db/kysely';
import { connect } from '@civitai/db-queries';
import type { DB } from '@civitai/db-schema/kysely';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import { datapacketDbRead } from '~/server/db/datapacketDb';

// Build Kysely clients over the app's EXISTING pg pools (pgDb / datapacketDb) — no new pools, no new
// connections — and hand them to @civitai/db-queries, which owns the client vars every query module imports.
// Prisma stays the schema/migration source of truth and the Kysely type generator; this is queries only.
// Imported at boot from instrumentation.node.ts so connect() runs before any query.
const { dbRead, dbWrite } = createKyselyClients<DB>({ pool: pgDbWrite, readPool: pgDbRead });

connect({
  read: dbRead,
  write: dbWrite,
  readLong: createKyselyClients<DB>({ pool: pgDbReadLong, singleClient: true }).db,
  datapacket: createKyselyClients<DB>({ pool: datapacketDbRead, singleClient: true }).db,
});
