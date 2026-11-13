// App Blocks document store: a signed-in USER's view of their own data across apps — the
// "App storage" card in account settings and the near-limit notice on a running app. Served by
// the `appStorage` router.
//
// Production namespace only: `dev:<uid>` is a developer's sandbox and `rev:` a moderator's
// review, and neither is data the user keeps in a published app. The figures are the store's
// stored per-viewer usage (`usage_user`), the number the per-viewer ceiling (`userBytes` /
// `userDocs`) is checked against on every write, so a bar here fills exactly as the store
// refuses: it counts the user's private documents, the shared documents they authored, and the
// counter documents their increment created.
//
// The cross-app listing is one indexed read of the user's own usage rows
// (`DocStoreViewerData.listViewerUsage`), one read of the listings' names, and per app the user
// holds data in, one aggregate read splitting that figure by what "Empty" does with it
// (`viewerHoldings`): counters they started and posts moderation hid stay, so a row made only of
// those has nothing to empty and says so. Emptying runs the store's own delete accounting
// (`emptyViewerData`).
import { dbRead } from '~/server/db/client';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import type {
  DocStoreViewerData,
  ViewerAppUsage,
  ViewerDataEmptyResult,
} from '~/server/services/apps/doc-store';
import { getDocStore } from '~/server/services/apps/doc-store.instance';
import { getDocStoreViewerData } from '~/server/services/apps/doc-store-viewer-data.instance';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import { docStoreUserLimits } from '~/server/services/blocks/user-app-caps.service';
import type {
  StorageFigure,
  StorageHoldings,
  ViewerStorageLimits,
} from '~/shared/utils/app-storage-usage';

export type MyAppStorageApp = {
  appBlockId: string;
  /** The listing's name; the block id for an app with no listing; null for a deleted app. */
  name: string | null;
  /** The app's slug (`AppBlock.blockId`), or null for a deleted app. */
  slug: string | null;
  usage: StorageFigure;
  /** `usage` by what Empty does with it: what it removes and what stays. */
  holdings: StorageHoldings;
};

export type MyAppStorage =
  /** Document storage is off here (no pool, or a role RLS does not bind): no figure is known. */
  { status: 'disabled' } | { status: 'ok'; limits: ViewerStorageLimits; apps: MyAppStorageApp[] };

export type MyAppStorageForApp =
  | { status: 'disabled' }
  | { status: 'ok'; limits: ViewerStorageLimits; usage: StorageFigure };

/** The app rows the listing names its entries from. */
export type AppNameLookup = (
  appBlockIds: string[]
) => Promise<{ id: string; blockId: string; listingName: string | null }[]>;

const lookupAppNames: AppNameLookup = async (ids) =>
  (
    await dbRead.appBlock.findMany({
      where: { id: { in: ids } },
      select: { id: true, blockId: true, appListing: { select: { name: true } } },
    })
  ).map((b) => ({ id: b.id, blockId: b.blockId, listingName: b.appListing?.name ?? null }));

export type ViewerLimitsLookup = (userId: number) => Promise<ViewerStorageLimits>;

/** Every app the user holds production documents in, by name, with their usage against the ceiling. */
export async function getMyAppStorage(
  userId: number,
  deps: {
    viewerData?: DocStoreViewerData;
    lookup?: AppNameLookup;
    limits?: ViewerLimitsLookup;
  } = {}
): Promise<MyAppStorage> {
  const viewerData = deps.viewerData ?? getDocStoreViewerData();
  const lookup = deps.lookup ?? lookupAppNames;
  const limitsOf = deps.limits ?? docStoreUserLimits;
  let rows: ViewerAppUsage[];
  try {
    rows = await viewerData.listViewerUsage(userId);
  } catch (err) {
    if (isDocStoreError(err, 'storage_disabled')) return { status: 'disabled' };
    throw err;
  }
  // The ceiling the store charges this user's writes against: their membership tier's.
  const limits = await limitsOf(userId);
  if (rows.length === 0) return { status: 'ok', limits, apps: [] };

  const byId = new Map((await lookup(rows.map((r) => r.appId))).map((a) => [a.id, a]));
  const apps: MyAppStorageApp[] = [];
  // One app at a time: a handful of rows per user, and never more than one pooled connection.
  for (const r of rows) {
    const app = byId.get(r.appId);
    apps.push({
      appBlockId: r.appId,
      name: app ? app.listingName ?? app.blockId : null,
      slug: app?.blockId ?? null,
      usage: { bytes: r.bytes, docs: r.docs },
      holdings: await viewerData.viewerHoldings(userId, r.appId),
    });
  }
  // Named apps by name, then the deleted ones; ties by id so the order is stable.
  apps.sort(
    (a, b) =>
      Number(a.name === null) - Number(b.name === null) ||
      (a.name ?? '').localeCompare(b.name ?? '') ||
      (a.appBlockId < b.appBlockId ? -1 : a.appBlockId > b.appBlockId ? 1 : 0)
  );
  return { status: 'ok', limits, apps };
}

/**
 * The user's usage in ONE app, for the running app's near-limit notice: one store read (two
 * primary-key lookups), issued once per app the user opens, never per storage call.
 */
export async function getMyAppStorageForApp(
  userId: number,
  appBlockId: string
): Promise<MyAppStorageForApp> {
  const store = getDocStore();
  try {
    const { viewer } = await store.usage({
      appId: appBlockId,
      ns: PUBLISHED_NS,
      viewerUid: userId,
    });
    return {
      status: 'ok',
      // The ceiling this store charges the user's writes against.
      limits: await store.viewerLimits(userId),
      usage: viewer ?? { bytes: 0, docs: 0 },
    };
  } catch (err) {
    if (isDocStoreError(err, 'storage_disabled')) return { status: 'disabled' };
    throw err;
  }
}

/**
 * Empty the user's data in one app's production namespace: their private documents, and with
 * `includeShared` also the visible shared documents they authored. Idempotent.
 */
export async function emptyMyAppStorage(
  userId: number,
  appBlockId: string,
  opts: { includeShared: boolean },
  deps: { viewerData?: DocStoreViewerData } = {}
): Promise<ViewerDataEmptyResult> {
  const viewerData = deps.viewerData ?? getDocStoreViewerData();
  return viewerData.emptyViewerData(userId, appBlockId, { shared: opts.includeShared });
}
