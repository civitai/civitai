import { env } from '~/env/server';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalAppdataDb: AugmentedPool | undefined;
}

/**
 * App Blocks document-store connection: the same datastore as `appsDb`, as a
 * least-privilege role that holds only `appdata_rw`. Row-level security does not
 * bind a superuser or BYPASSRLS role, so the store requires its own
 * least-privilege connection (and checks the role on first use). Only
 * `doc-store.instance.ts` uses it.
 *
 * Optional: when `APPDATA_DATABASE_URL` is unset this is `null` and every
 * document-store call fails closed with `storage_disabled`. It deliberately has
 * no fallback to `appsDb`.
 */
export let appdataDb: AugmentedPool | null = null;

// Process-global in every environment, like the other pools.
if (!env.IS_BUILD && env.APPDATA_DATABASE_URL) {
  appdataDb = globalThis.globalAppdataDb ??= getClient({ instance: 'appdata' });
}
