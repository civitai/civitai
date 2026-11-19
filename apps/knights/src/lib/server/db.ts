import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { DB } from '@civitai/db-schema/kysely';

function required(name: 'DATABASE_URL'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// `db` is the primary: every write, every transaction and every read that must see the player's own just-written rows.
// `dbRead` is a read replica when DATABASE_REPLICA_URL is set, for reads that tolerate a little lag (the play feed,
// cached boards and catalogs). Unset or empty, createKyselyClients hands back the primary as `dbRead` too.
const { dbWrite, dbRead } = createKyselyClients<DB>({
  connectionString: required('DATABASE_URL'),
  replicaConnectionString: env.DATABASE_REPLICA_URL || undefined,
  sslNoVerify: true,
});

export { dbWrite as db, dbRead };
