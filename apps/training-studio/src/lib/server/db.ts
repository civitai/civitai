import { createKyselyClients } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import type { DB } from '@civitai/db-schema/kysely';

function required(name: 'DATABASE_URL'): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// Single client (no replica): the app's only DB use is minting a short-lived `System` ApiKey for the
// orchestrator token — a write, plus a read-your-own cleanup. `sslNoVerify` handles the cnpg pooler's
// self-signed cert (same as the moderator app and the main app's db-helpers).
export const { db } = createKyselyClients<DB>({
  connectionString: required('DATABASE_URL'),
  sslNoVerify: true,
  singleClient: true,
});
