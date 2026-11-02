// App Blocks document store: the server's one entry point for deleting stored data in bulk,
// outside a viewer's own block-token calls.
//
//   - `purgeViewerDocuments(userId)`: one user's data in every app (the opt-in on account
//     deletion, `jobs/remove-deleted-account-app-data.ts`); with `{ appId }`, in that app only.
//   - `purgeAppDocuments(appId)`: every user's data in one app, in every namespace (the
//     deleted-app reaper, `jobs/reap-deleted-app-storage.ts`).
//
// Both go through the store's own maintenance operations (`DocStoreMaintenance.wipeAccount`,
// `.purgeApp`), so usage counters, tallies and tombstones follow the same rules as every other
// delete. What a viewer purge deletes, per namespace the user has rows in (`wipeAccount`):
//   - their private documents;
//   - the shared documents they AUTHORED, exactly as a moderator delete does (index rows,
//     tallies, every user's marks on them, app and author refunds, tombstones). Asking for your
//     data to go includes what you published into an app; nothing in the store can re-attribute
//     a document to another author;
//   - their marks (votes, reports) with each tally decremented, and their usage rows;
//   - their own dev namespace (`dev:<uid>`) of that app in full.
// Counter documents created by their increments keep their counts and lose the uid.
//
// Callers must not hold a main-database transaction across these calls: the store is a separate
// database, and a purge can take many transactions.
import type { DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { getDocStoreMaintenance } from '~/server/services/apps/doc-store-maintenance.instance';
import type { AccountWipeResult } from '~/server/services/apps/doc-store.types';

/**
 * Delete what the store holds for `userId` — in every app, or in `opts.appId` only. Idempotent.
 * A namespace whose transaction failed rolled back in full and is listed in `failures`; a re-run
 * retries it. Throws `storage_disabled` when the store is off.
 */
export async function purgeViewerDocuments(
  userId: number,
  opts: { appId?: string; store?: DocStoreMaintenance } = {}
): Promise<AccountWipeResult> {
  const store = opts.store ?? getDocStoreMaintenance();
  return store.wipeAccount(userId, opts.appId === undefined ? {} : { appId: opts.appId });
}

export type AppPurgeResult = Awaited<ReturnType<DocStoreMaintenance['purgeApp']>>;

/**
 * Delete every row `appId` has in the store, in every namespace, in bounded batches.
 * `proceed` runs before every batch; return false to stop (e.g. the app was restored).
 * Resumable: a call that ran out of `maxRows` (`done: false`) continues on the next call.
 */
export async function purgeAppDocuments(
  appId: string,
  opts: {
    batchRows?: number;
    maxRows?: number;
    proceed?: () => Promise<boolean>;
    store?: DocStoreMaintenance;
  } = {}
): Promise<AppPurgeResult> {
  const { store = getDocStoreMaintenance(), ...rest } = opts;
  return store.purgeApp(appId, rest);
}
