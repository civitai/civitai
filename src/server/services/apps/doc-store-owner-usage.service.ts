// App Blocks document store: an app OWNER's view of their apps' storage usage against the
// per-app limits. Served by `appListings.getMyDocStoreUsage`.
//
// Owner only. The app set is the caller's OWNED blocks from `resolveAccessibleAppBlockIds`,
// the canonical owner resolution (`AppBlock.app.userId`). An accepted collaborator's seat
// does not reach it: the figure is app-wide (every user's data in the app), and the limits it
// is measured against are the owner's to manage. Off-site blocks have no document store and
// are left out.
//
// Production namespace only: `dev:<uid>` is one developer's sandbox and `rev:` belongs to a
// pending review, and neither counts against the published app. The read is the store's own
// `usage()` on the least-privilege connection, one transaction per app (`readEachApp`), the
// same path the moderator report queue reads apps through.
import { dbRead } from '~/server/db/client';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import { getDocStore } from '~/server/services/apps/doc-store.instance';
import { readEachApp } from '~/server/services/apps/doc-store-per-app';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import { resolveAccessibleAppBlockIds } from '~/server/services/blocks/app-access.service';

export type OwnerAppDocStoreUsage = {
  appBlockId: string;
  /** The listing's name, or the block id for an app with no listing yet. */
  name: string;
  /** Production usage; null when this app's read failed (unknown, not zero). */
  usage: { bytes: number; docs: number } | null;
};

export type MyDocStoreUsage =
  /** Document storage is off here (no pool, or a role RLS does not bind): no figure is known. */
  | { status: 'disabled' }
  | {
      status: 'ok';
      /** The per-app ceilings, in the stored unit. */
      limits: { appBytes: number; appDocs: number };
      apps: OwnerAppDocStoreUsage[];
    };

export async function getMyDocStoreUsage(userId: number): Promise<MyDocStoreUsage> {
  const store = getDocStore();
  const limits = { appBytes: store.limits.appBytes, appDocs: store.limits.appDocs };
  const { ownedIds } = await resolveAccessibleAppBlockIds(userId);
  if (ownedIds.length === 0) return { status: 'ok', limits, apps: [] };

  const blocks = await dbRead.appBlock.findMany({
    where: { id: { in: ownedIds }, externalUrl: null },
    select: { id: true, blockId: true, appListing: { select: { name: true } } },
  });
  const apps = blocks
    .map((b) => ({ appBlockId: b.id, name: b.appListing?.name ?? b.blockId }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.appBlockId < b.appBlockId ? -1 : 1));

  try {
    const reads = await readEachApp(
      apps,
      async (app) => {
        const { app: usage } = await store.usage({
          appId: app.appBlockId,
          ns: PUBLISHED_NS,
          viewerUid: null,
        });
        return usage;
      },
      'doc_store_owner_usage_app_failed'
    );
    return {
      status: 'ok',
      limits,
      apps: reads.map((r) => ({ ...r.app, usage: r.ok ? r.value : null })),
    };
  } catch (err) {
    if (isDocStoreError(err, 'storage_disabled')) return { status: 'disabled' };
    throw err;
  }
}
