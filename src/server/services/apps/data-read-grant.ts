// THE rule for whether a user, through an app, may read one collection of an app's storage.
// One predicate, so the document-store route (`doc-store-access.ts`, through an import) and any
// other reader of app data cannot disagree about it. Who may import this module is pinned by
// `__tests__/data-read-grant.ledger.test.ts`.
//
//   basis   when                                        what must also hold
//   own     the reading client IS the source app        the user may run apps; the source
//                                                       declares the collection
//   grant   the reading client is another app that      its manifest declares the import of
//           imports from the source                     the collection; the source declares it
//                                                       exportable; the user granted the
//                                                       consumer `apps:storage:import` and a
//                                                       per-source grant covering the import
//
// Both: the source is approved, and its content rating is within the reader's mature ceiling.
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { declaredStorage } from '~/server/services/apps/doc-store-declared';
import { docStoreDependency, docStoreUnavailable } from '~/server/services/apps/doc-store.types';
import {
  getStorageImportGrant,
  importGrantCovers,
} from '~/server/services/apps/storage-import-grant.service';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import { getGrantedScopes } from '~/server/services/blocks/scope-grant.service';
import {
  APP_STORAGE_IMPORT_SCOPE,
  isCollectionExportable,
  type DeclaredStorageCollections,
  type DeclaredStorageImports,
} from '~/shared/constants/block-storage.constants';

export type DataReader = {
  userId: number;
  /** The OAuth client reading: an app's `AppBlock.appId`. */
  clientId: string;
  /** Whether the reader may see an app rated `rating` (its mature ceiling). */
  matureAllowed: (rating: string | null) => boolean;
};

export type CollectionReadTarget = {
  /** The source app's `blockId` (as a manifest's `imports[].from` names it). */
  sourceBlockId: string;
  collection: string;
};

/**
 * The consumer app as a VERIFIED block token already resolved it (`resolveStorageAccess`: the
 * strict approval read and the run gate on the viewer have run). With it, the read can only be an
 * import: the basis is `grant`, and a source that is the consumer itself is refused.
 */
export type ImportingApp = {
  /** The approved consumer's `AppBlock.id`. */
  appBlockId: string;
  /** The imports its approved manifest declares. */
  imports: DeclaredStorageImports;
  /** Whether the token carries `apps:storage:import`, or the consent state could not be read. */
  importScope: 'held' | 'missing' | 'unavailable';
};

export type CollectionReadRefusal =
  | 'source_not_approved'
  | 'apps_disabled'
  | 'consumer_not_found'
  | 'consumer_ambiguous'
  | 'import_self'
  | 'import_not_declared'
  | 'source_rating'
  | 'collection_not_declared'
  | 'not_exportable'
  | 'import_scope_missing'
  | 'import_scope_unavailable'
  | 'import_not_granted';

/** The source app a decision read, for a caller that goes on to use it. */
export type CollectionReadSource = {
  id: string;
  appId: string;
  manifest: unknown;
  updatedAt: Date | null;
  collections: DeclaredStorageCollections;
};

export type CollectionReadDecision =
  | { ok: true; basis: 'own' | 'grant'; source: CollectionReadSource }
  | { ok: false; reason: CollectionReadRefusal };

const refuse = (reason: CollectionReadRefusal): CollectionReadDecision => ({ ok: false, reason });

/** What the predicate runs that is not a database read: the App Blocks run gate. */
export type CollectionReadDeps = {
  /** Resolves when `userId` may run apps; throws a `TRPCError` when they may not. */
  assertMayRunApps: (userId: number) => Promise<void>;
};

/**
 * The predicate over `deps`. Production code imports {@link decideCollectionRead}, never this:
 * the ledger test pins that no production module imports it.
 */
export function createCollectionReadDecider(deps: CollectionReadDeps) {
  return (reader: DataReader, target: CollectionReadTarget, via?: ImportingApp) =>
    decide(deps, reader, target, via);
}

/**
 * Whether `reader` may read `target.collection` of the app `target.sourceBlockId`, and on what
 * basis. A refusal is a result; a read that fails (the database) or a manifest that does not parse
 * throws a retryable `DocStoreError`, never a refusal. Checks run in order, each before any read
 * the next one needs.
 *
 * `via`: the consumer as a verified block token resolved it ({@link ImportingApp}). Without it the
 * consumer is resolved from `reader.clientId`, and its consent from the scope ledger.
 */
export const decideCollectionRead: (
  reader: DataReader,
  target: CollectionReadTarget,
  via?: ImportingApp
) => Promise<CollectionReadDecision> = createCollectionReadDecider({
  assertMayRunApps: (userId) => assertAppBlocksEnabledForTokenUser(userId),
});

async function decide(
  deps: CollectionReadDeps,
  reader: DataReader,
  target: CollectionReadTarget,
  via?: ImportingApp
): Promise<CollectionReadDecision> {
  const { sourceBlockId, collection } = target;
  // Through a verified token, an undeclared import needs no read to refuse.
  if (via && !via.imports.get(sourceBlockId)?.collections.has(collection)) {
    return refuse('import_not_declared');
  }

  const source = await docStoreDependency(
    dbRead.appBlock.findUnique({
      where: { blockId: sourceBlockId },
      select: { id: true, appId: true, status: true, manifest: true, updatedAt: true },
    })
  );
  if (!source || source.status !== 'approved') return refuse('source_not_approved');

  // A verified block token's viewer already passed the run gate (`resolveStorageAccess`).
  if (!via) {
    const disabled = await runGateRefusal(deps, reader.userId);
    if (disabled) return disabled;
  }

  let consumer: { appBlockId: string; imports: DeclaredStorageImports } | null = null;
  if (via) {
    if (source.id === via.appBlockId) return refuse('import_self');
    consumer = via;
  } else if (reader.clientId !== source.appId) {
    const found = await resolveConsumer(reader.clientId);
    if (!found.ok) return found;
    consumer = found.consumer;
  }
  const declaredImport = consumer?.imports.get(sourceBlockId);
  if (consumer && !declaredImport?.collections.has(collection)) {
    return refuse('import_not_declared');
  }

  // The mint refuses a mature-rated app off a red-capable host; its documents must not reach that
  // host through another app either.
  const rating = (source.manifest as { contentRating?: unknown } | null)?.contentRating;
  if (!reader.matureAllowed(typeof rating === 'string' ? rating : null)) {
    return refuse('source_rating');
  }
  const { collections } = declaredStorage(source.id, source.manifest);
  const decl = collections.get(collection);
  if (!decl) return refuse('collection_not_declared');
  const read: CollectionReadSource = {
    id: source.id,
    appId: source.appId,
    manifest: source.manifest,
    updatedAt: source.updatedAt,
    collections,
  };
  if (!consumer || !declaredImport) return { ok: true, basis: 'own', source: read };

  if (!isCollectionExportable(decl)) return refuse('not_exportable');
  const scope = via
    ? via.importScope
    : (
        await docStoreDependency(
          getGrantedScopes({ userId: reader.userId, appBlockId: consumer.appBlockId, db: 'write' })
        )
      ).has(APP_STORAGE_IMPORT_SCOPE)
    ? 'held'
    : 'missing';
  if (scope === 'unavailable') return refuse('import_scope_unavailable');
  if (scope === 'missing') return refuse('import_scope_missing');
  const grant = await docStoreDependency(
    getStorageImportGrant({
      userId: reader.userId,
      consumerAppBlockId: consumer.appBlockId,
      sourceAppBlockId: source.id,
    })
  );
  if (!importGrantCovers(grant, declaredImport)) return refuse('import_not_granted');
  return { ok: true, basis: 'grant', source: read };
}

/** The App Blocks run gate on the reader: a refusal, or null when they may run apps. */
async function runGateRefusal(
  deps: CollectionReadDeps,
  userId: number
): Promise<CollectionReadDecision | null> {
  try {
    await deps.assertMayRunApps(userId);
    return null;
  } catch (err) {
    if (err instanceof TRPCError) return refuse('apps_disabled');
    throw docStoreUnavailable();
  }
}

/**
 * The approved app whose OAuth client is `clientId`, with its declared imports. `appId` is not
 * unique on its own, so more than one approved app for a client is refused, never guessed.
 */
async function resolveConsumer(
  clientId: string
): Promise<
  | { ok: true; consumer: { appBlockId: string; imports: DeclaredStorageImports } }
  | { ok: false; reason: CollectionReadRefusal }
> {
  const rows = await docStoreDependency(
    dbRead.appBlock.findMany({
      where: { appId: clientId, status: 'approved' },
      select: { id: true, manifest: true },
      take: 2,
    })
  );
  if (rows.length === 0) return { ok: false, reason: 'consumer_not_found' };
  if (rows.length > 1) return { ok: false, reason: 'consumer_ambiguous' };
  const [row] = rows;
  return {
    ok: true,
    consumer: { appBlockId: row.id, imports: declaredStorage(row.id, row.manifest).imports },
  };
}
