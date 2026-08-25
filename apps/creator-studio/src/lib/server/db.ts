import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { DB } from '@civitai/db-schema/kysely';

// sslNoVerify is required for the cnpg pooler's self-signed cert.
function required(name: 'DATABASE_URL' | 'DATABASE_REPLICA_URL'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// `pool` is the primary pg pool: `hooks.server.ts`'s `init` needs it to register the enum-array type
// parsers before the first query. See registerEnumArrayTypeParsers in @civitai/db/kysely.
export const {
  dbRead,
  dbWrite,
  pool: dbPool,
} = createKyselyClients<DB>({
  connectionString: required('DATABASE_URL'),
  replicaConnectionString: required('DATABASE_REPLICA_URL'),
  sslNoVerify: true,
});
