import { logToAxiom } from '~/server/logging/client';
import type { SyncSubListingForSharedRowArgs } from '~/server/services/blocks/app-sub-listing.service';

/**
 * The item's store card (an app sub-listing) follows an in-app withdraw or moderator hide,
 * from the server, so the store never depends on the app to clean up. Called by both shared
 * stores: the legacy per-app shared storage (`apps-shared.router.ts`) and the App Blocks
 * document store (`doc-store-api.ts`, `doc-store-moderation.service.ts`).
 *
 * Best-effort: the shared-storage write has already committed in another database, so this
 * never throws — a failure is logged and the store's own moderator hide still catches it.
 */
export async function syncStoreItem(args: SyncSubListingForSharedRowArgs): Promise<void> {
  try {
    const { syncSubListingForSharedRow } = await import(
      '~/server/services/blocks/app-sub-listing.service'
    );
    await syncSubListingForSharedRow(args);
  } catch (err) {
    logToAxiom({
      name: 'app-sub-listing-shared-sync-failed',
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
  }
}
