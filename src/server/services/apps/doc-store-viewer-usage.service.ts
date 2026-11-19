// App Blocks document store: a signed-in USER's view of their own data across apps — the
// "App storage" card in account settings and the near-limit notice on a running app. Served by
// the `appStorage` router.
//
// The EXPORT (`exportMyAppRecords`, behind the record core's switch) reads the same production
// data: every record the user owns across apps, whatever each app's status, as record-core objects.
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
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import {
  collectionSchemaDocuments,
  exportedCollections,
} from '~/server/registry-adapter/collection-schema';
import { createClaimer, familyDigest } from '~/server/registry-adapter/doc-feed';
import type {
  AppRecord,
  AppRecordConfig,
  RecordSchemaClaim,
} from '~/server/services/apps/app-record';
import { recordBodyBytes, toAppRecord } from '~/server/services/apps/app-record';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import type {
  DocStoreViewerData,
  ViewerAppUsage,
  ViewerDataEmptyResult,
  ViewerRecordCursor,
} from '~/server/services/apps/doc-store';
import { DOC_STORE_BOUNDS } from '~/server/services/apps/doc-store.types';
import type { ApprovedManifest } from '~/server/services/apps/storage-schema-majors';
import {
  deriveCollectionMajors,
  manifestHistory,
} from '~/server/services/apps/storage-schema-majors';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  APP_STORAGE_ENABLED_FEATURES,
  parseManifestStorage,
  type DeclaredStorageCollection,
} from '~/shared/constants/block-storage.constants';
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

// ---------------------------------------------------------------------------
// EXPORT: every record the user owns, across every app, as record-core objects.
// ---------------------------------------------------------------------------

/** Records per export page at most (the router's input bound). */
export const APP_RECORD_EXPORT_PAGE_MAX = 100;
/**
 * A page stops taking records once their bodies reach this many bytes, so one page carries at
 * most this plus one record's body (`APP_RECORD_BODY_MAX_BYTES`, 64 KiB) of body bytes.
 */
export const APP_RECORD_EXPORT_PAGE_BODY_BYTES = 1024 * 1024;

/** Why some of the user's documents are not in the bundle, counted per app. */
export type AppRecordExportSkipReason =
  /** No app row to name the records from (no slug for their URN): the app's row is gone. */
  | 'app_unknown'
  /** The app's enforced manifest no longer declares the collection: no owner policy to apply. */
  | 'collection_not_declared'
  /** The record core refused the row (a private row with no `record_id` yet). */
  | 'unreadable';

export type MyAppRecordsPage = {
  /** `app-records/v1`: an array of record-core objects (`app-record.ts`). */
  format: 'app-records/v1';
  records: AppRecord[];
  /** Pass back as `cursor` for the next page; null when this page was the last. */
  nextCursor: string | null;
  skipped: Array<{ appBlockId: string; reason: AppRecordExportSkipReason; docs: number }>;
};

/** What the export needs of one app: its slug, its declared collections, its schema families. */
export type AppRecordExportApp = {
  slug: string;
  collections: ReadonlyMap<string, DeclaredStorageCollection>;
  claim(collection: string): RecordSchemaClaim;
};

export type AppRecordExportAppLookup = (appBlockId: string) => Promise<AppRecordExportApp | null>;

const noSchemas: RecordSchemaClaim = () => [];

/**
 * One app as the export reads it, whatever its status (a delisted app's row is kept): the slug is
 * `AppBlock.blockId`, the collections come from its enforced manifest, and the schemas a body
 * claims are the registry feed's (`createClaimer` over the collection's family, derived from the
 * approved history then the enforced manifest, as `doc-streams.ts` derives it), for the
 * collections the manifest publishes to the registry; any other collection claims none.
 */
function appRecordExportLookup(): AppRecordExportAppLookup {
  const claimer = createClaimer();
  return async (appBlockId) => {
    const block = await dbRead.appBlock.findUnique({
      where: { id: appBlockId },
      select: { blockId: true, manifest: true },
    });
    if (!block) return null;
    const approved: ApprovedManifest[] = await dbRead.appBlockPublishRequest.findMany({
      where: { appBlockId, status: 'approved' },
      select: { id: true, manifest: true, reviewedAt: true },
    });
    const derivation = deriveCollectionMajors(manifestHistory(approved, block.manifest));
    const published = exportedCollections(block.manifest, APP_STORAGE_ENABLED_FEATURES);
    const collections = parseManifestStorage(
      block.manifest,
      APP_STORAGE_ALL_FEATURES_ON
    ).collections;
    const claims = new Map<string, RecordSchemaClaim>();
    return {
      slug: block.blockId,
      collections,
      claim(collection) {
        if (!published.has(collection)) return noSchemas;
        let c = claims.get(collection);
        if (!c) {
          const family = collectionSchemaDocuments(
            block.blockId,
            derivation,
            new Set([collection])
          );
          c = family.length === 0 ? noSchemas : claimer(family, familyDigest(family));
          claims.set(collection, c);
        }
        return c;
      },
    };
  };
}

type ExportCursor = { appId: string } & ViewerRecordCursor;

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function encodeExportCursor(c: ExportCursor): string {
  return Buffer.from(JSON.stringify([c.appId, c.coll, c.scopeUid, c.key]), 'utf8').toString(
    'base64url'
  );
}

function decodeExportCursor(raw: string): ExportCursor {
  const bad = () => new TRPCError({ code: 'BAD_REQUEST', message: 'invalid cursor' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw bad();
  const [appId, coll, scopeUid, key] = parsed as unknown[];
  if (
    typeof appId !== 'string' ||
    !APP_ID_RE.test(appId) ||
    typeof coll !== 'string' ||
    !DOC_STORE_BOUNDS.collectionName.test(coll) ||
    typeof scopeUid !== 'number' ||
    !Number.isSafeInteger(scopeUid) ||
    scopeUid < 0 ||
    typeof key !== 'string' ||
    !DOC_STORE_BOUNDS.key.test(key)
  ) {
    throw bad();
  }
  return { appId, coll, scopeUid, key };
}

/**
 * One page of the bundle of every record `userId` owns, across every app they hold production
 * data in (`listViewerUsage`), whatever each app's status: their private documents and the visible
 * shared documents they created (`viewerRecords`), each turned into a record by `toAppRecord`
 * alone. The store reads only the caller's own rows; a record whose owner is not the caller is
 * dropped as a second check, so the bundle never carries another user's data. A record's `owner`
 * is `{ kind: 'user', userId }` with the caller's own id: the bundle goes only to that user.
 *
 * Bounded per page: at most `limit` (≤ {@link APP_RECORD_EXPORT_PAGE_MAX}) records, and no
 * record is added once the page's bodies reach {@link APP_RECORD_EXPORT_PAGE_BODY_BYTES}. In
 * (app, collection, key space, key) order; `nextCursor` resumes after the last row read.
 *
 * `config` is the record core's: the caller holds one only while it is switched on.
 */
export async function exportMyAppRecords(
  config: AppRecordConfig,
  userId: number,
  opts: { cursor?: string | null; limit?: number } = {},
  deps: { viewerData?: DocStoreViewerData; lookup?: AppRecordExportAppLookup } = {}
): Promise<MyAppRecordsPage> {
  const viewerData = deps.viewerData ?? getDocStoreViewerData();
  const lookup = deps.lookup ?? appRecordExportLookup();
  const limit = opts.limit ?? APP_RECORD_EXPORT_PAGE_MAX;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > APP_RECORD_EXPORT_PAGE_MAX) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `limit must be 1–${APP_RECORD_EXPORT_PAGE_MAX}`,
    });
  }
  const start = opts.cursor ? decodeExportCursor(opts.cursor) : null;
  let usage: ViewerAppUsage[];
  try {
    usage = await viewerData.listViewerUsage(userId);
  } catch (err) {
    // Storage off here: no record is known, which is not the same as having none.
    if (isDocStoreError(err, 'storage_disabled')) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'App storage is not available' });
    }
    throw err;
  }
  const apps = usage.filter((a) => start === null || a.appId >= start.appId);

  const records: AppRecord[] = [];
  const skippedBy = new Map<string, MyAppRecordsPage['skipped'][number]>();
  const skip = (appBlockId: string, reason: AppRecordExportSkipReason, docs = 1) => {
    const k = `${appBlockId}\u0000${reason}`;
    const entry = skippedBy.get(k) ?? { appBlockId, reason, docs: 0 };
    entry.docs += docs;
    skippedBy.set(k, entry);
  };
  let bodyBytes = 0;
  const page = (nextCursor: string | null): MyAppRecordsPage => ({
    format: 'app-records/v1',
    records,
    nextCursor,
    skipped: [...skippedBy.values()],
  });

  for (const usage of apps) {
    const appId = usage.appId;
    let after: ViewerRecordCursor | null =
      start !== null && appId === start.appId
        ? { coll: start.coll, scopeUid: start.scopeUid, key: start.key }
        : null;
    const app = await lookup(appId);
    if (!app) {
      // Counted once, on the page that reaches the app.
      if (after === null) skip(appId, 'app_unknown', usage.docs);
      continue;
    }
    for (;;) {
      const want = limit - records.length;
      const rows = await viewerData.viewerRecords(userId, appId, { after, limit: want });
      for (const row of rows) {
        const pos: ViewerRecordCursor = { coll: row.coll, scopeUid: row.scopeUid, key: row.key };
        after = pos;
        const decl = app.collections.get(row.coll);
        if (!decl) {
          skip(appId, 'collection_not_declared');
          continue;
        }
        let record: AppRecord;
        try {
          record = toAppRecord(config, {
            slug: app.slug,
            collection: row.coll,
            policy: decl,
            row: {
              key: row.key,
              data: row.data,
              version: row.version,
              author: row.author,
              scopeUid: row.scopeUid,
              lastWriterUid: row.lastWriterUid,
              recordId: row.recordId,
            },
            // Which version of the app wrote the row is not stored.
            writer: { app: app.slug, version: null },
            claim: app.claim(row.coll),
          });
        } catch {
          skip(appId, 'unreadable');
          continue;
        }
        if (record.owner.kind !== 'user' || record.owner.userId !== userId) continue;
        records.push(record);
        bodyBytes += recordBodyBytes(record.body);
        if (records.length >= limit || bodyBytes >= APP_RECORD_EXPORT_PAGE_BODY_BYTES) {
          return page(encodeExportCursor({ appId, ...pos }));
        }
      }
      if (rows.length < want) break;
    }
  }
  return page(null);
}
