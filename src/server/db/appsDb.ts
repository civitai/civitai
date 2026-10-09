import { types } from 'pg';
import { env } from '~/env/server';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalAppsDb: AugmentedPool | undefined;
}

// Fix Dates — keep the same type-parser stance as notifDb.
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

/**
 * App Blocks KV datastore connection (cnpg-cluster-apps). civitai-web is
 * the only service with credentials here; blocks themselves talk to this
 * cluster only through host-mediated tRPC procedures
 * (`apps.storage.{get,set,delete,list,getQuota}`).
 *
 * Optional: when `APPS_DATABASE_URL` is unset (PR previews, dev
 * environments, the legacy stage cluster), `appsDb` is `null` and the
 * tRPC procedures must throw cleanly rather than crash the import graph.
 * Use `requireAppsDb()` at the procedure entry to surface a clear error.
 */
export let appsDb: AugmentedPool | null = null;

// Process-global in every environment, like the pgDb pools (see the note there).
if (!env.IS_BUILD && env.APPS_DATABASE_URL) {
  appsDb = globalThis.globalAppsDb ??= getClient({ instance: 'apps' });
}

export function requireAppsDb(): AugmentedPool {
  if (!appsDb) {
    throw new Error(
      'APPS_DATABASE_URL is not configured — App Blocks KV datastore is unavailable in this environment.'
    );
  }
  return appsDb;
}
