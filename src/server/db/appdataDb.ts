import { env } from '~/env/server';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalAppdataDb: AugmentedPool | undefined;
}

/**
 * App Blocks document-store connection: the same datastore as `appsDb`, but as a
 * least-privilege role that holds only `appdata_rw` — so the row-level security
 * on the `appdata` tables actually binds it (it never binds a superuser, which
 * is what `appsDb` connects as). Only `doc-store.instance.ts` uses it.
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
