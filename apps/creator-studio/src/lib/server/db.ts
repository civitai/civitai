import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { DB } from '@civitai/db-schema/kysely';

// sslNoVerify is required for the cnpg pooler's self-signed cert.
function required(name: 'DATABASE_URL' | 'DATABASE_REPLICA_URL'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export const { dbRead, dbWrite } = createKyselyClients<DB>({
  connectionString: required('DATABASE_URL'),
  replicaConnectionString: required('DATABASE_REPLICA_URL'),
  sslNoVerify: true,
});
