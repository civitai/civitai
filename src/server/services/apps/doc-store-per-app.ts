// App Blocks document store: one read per app, for server surfaces that report across
// several apps (the moderator report queue, an owner's storage usage).
//
// The store connects as a least-privilege role that row-level security binds, and every
// transaction is bound to ONE (app, namespace), so nothing spans apps in SQL. A cross-app
// read is one store call per app, each in its own transaction bound to that app, with at
// most `DOC_STORE_APP_CONCURRENCY` in flight.
import pLimit from 'p-limit';
import { logToAxiom } from '~/server/logging/client';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

/** Per-app store transactions in flight at once during a cross-app read. */
export const DOC_STORE_APP_CONCURRENCY = 4;

export type PerAppRead<A, R> = { app: A; ok: true; value: R } | { app: A; ok: false };

/**
 * Run `read` once per app, in input order. If one app's read fails, that app comes back
 * `ok: false` (logged as `failureEvent`) and the others still return. `storage_disabled`
 * means storage as a whole is off (no pool, or a role RLS does not bind), not that one
 * app failed, so it is rethrown.
 */
export async function readEachApp<A extends { appBlockId: string }, R>(
  apps: A[],
  read: (app: A) => Promise<R>,
  failureEvent: string
): Promise<PerAppRead<A, R>[]> {
  const limit = pLimit(DOC_STORE_APP_CONCURRENCY);
  return Promise.all(
    apps.map((app) =>
      limit(async (): Promise<PerAppRead<A, R>> => {
        try {
          return { app, ok: true, value: await read(app) };
        } catch (err) {
          if (isDocStoreError(err, 'storage_disabled')) throw err;
          logToAxiom(
            {
              type: 'error',
              event: failureEvent,
              appBlockId: app.appBlockId,
              error: err instanceof Error ? err.message : String(err),
            },
            'app-blocks'
          ).catch(() => undefined);
          return { app, ok: false };
        }
      })
    )
  );
}
