import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { DB } from '@civitai/db-schema/kysely';

function required(name: 'DATABASE_URL'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export const { db } = createKyselyClients<DB>({
  connectionString: required('DATABASE_URL'),
  sslNoVerify: true,
  singleClient: true,
});
