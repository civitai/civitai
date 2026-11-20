import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { db } from '$lib/server/db/db';

// The offline-grant columns are `@no-type` in schema.full.prisma (migration
// `20271119140000_oauth_offline_grant`), so the generated `DB` type does not name them and no query
// typed against it can reach them by accident. This is the one typed view that can: only flag-on
// code (`oauth-offline-grant`) goes through it, so with the flag off nothing reads or writes the
// columns, whether or not the migration has been applied.

/** How an OAuth access token was minted. On a `Refresh` row, the grant that started its chain. */
export type MintOrigin =
  | 'app_token'
  | 'auth_code'
  | 'refresh'
  | 'device_code'
  | 'client_credentials';

/** The grants that start a refresh chain. */
export type ChainOrigin = Extract<MintOrigin, 'auth_code' | 'device_code'>;

type OfflineDB = Omit<DB, 'ApiKey' | 'OauthConsent'> & {
  ApiKey: DB['ApiKey'] & { mintOrigin: MintOrigin | null; refreshFamilyId: string | null };
  OauthConsent: DB['OauthConsent'] & { offlineGrantedAt: Date | null };
};

export type OfflineExecutor = Kysely<OfflineDB>;

/** The hub's database, typed with the offline-grant columns. Flag-on code only. */
export function offlineDb(executor: Kysely<DB> = db as unknown as Kysely<DB>): OfflineExecutor {
  return executor as unknown as OfflineExecutor;
}
