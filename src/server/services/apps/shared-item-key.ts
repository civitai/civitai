// Resolve an app-supplied shared item KEY to the published item it names, for server code that
// checks one by key: App Store sub-listings (author + hidden) and spend attribution (author).
// An app's shared items live in the App Blocks document store or in its legacy per-app shared
// storage (`app_<slug>.shared_kv`). Which one is decided by the app's APPROVED manifest: an app
// that declares at least one ITEM collection (shared, and a write policy under which viewers
// author documents: `collectionNeedsPublishScope`) has moved, and the document store alone is
// authoritative for it (a miss is no item; the legacy store is never read, so a legacy copy left
// behind by the move cannot bring back an item deleted from the document store). An app that
// declares none — or an environment without a document store — resolves from the legacy store,
// exactly as before the document store existed.
//
// Any other shared collection never holds an item. A `write: "none"` one exists only for marks
// and counters, which an app commonly keys by the item's own key (e.g. per-item downvotes); an
// owner-written one has no user author. Neither moves an app nor takes part in a lookup, so such
// a document can neither make a key ambiguous nor answer for an item.
//
// Accepted trade-off: between a version that declares shared collections going live and the
// copy of its legacy rows finishing (run right after go-live), an old key does not resolve.
//
// "Declares an item collection" is taken to mean "has moved"; nothing else enforces it, and
// the legacy shared-write routes stay open. Consequences, by design:
//   - once an app's approved manifest declares an item collection, the document store is the
//     only source for key → item: legacy shared rows written afterwards (e.g. by an old open
//     tab) never resolve;
//   - an app that keeps a legacy shared feed alongside a declared item collection loses
//     lookups for its legacy keys;
//   - rollback hazard: re-approving a manifest with no item collection makes legacy
//     authoritative again — leftover legacy copies of deleted documents come back, and items
//     that exist only in the document store stop resolving.
//
// Document store: production namespace only, so a dev or review document never resolves; only
// the item collections the APPROVED manifest declares are probed, so an app with none costs
// no document-store query.
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

export type SharedItem =
  | { kind: 'found'; authorUid: number | null; hidden: boolean }
  /**
   * More than one declared item collection holds the key (the store's primary key includes
   * the collection), so the key does not name one item.
   */
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * The item `key` names, hidden included, from the store the app's manifest makes authoritative.
 *
 * Throws when a store or the manifest cannot be read: the caller then cannot tell found from
 * missing.
 */
export async function resolveSharedItem(args: {
  /** Server-derived AppBlock id. */
  appBlockId: string;
  /** `AppBlock.blockId`, which names the legacy schema. */
  blockId: string;
  /** The app's approved manifest (`AppBlock.manifest`). */
  manifest: unknown;
  key: string;
}): Promise<SharedItem> {
  const doc = await findInDocStore(args);
  if (doc.kind !== 'not_authoritative') return doc;
  const legacy = await readLegacySharedItem(args.blockId, args.key);
  return legacy ? { kind: 'found', ...legacy } : { kind: 'none' };
}

type DocStoreResult =
  | SharedItem
  /** The app declares no item collection, or there is no document store here: use legacy. */
  | { kind: 'not_authoritative' };

async function findInDocStore(args: {
  appBlockId: string;
  manifest: unknown;
  key: string;
}): Promise<DocStoreResult> {
  const { declaredCollections } = await import('~/server/services/apps/doc-store-access');
  const { collectionNeedsPublishScope } = await import(
    '~/shared/constants/block-storage.constants'
  );
  // The item collections: the same allowlist that decides which collections need the publish
  // scope (shared, viewer-authored), so a new write policy is classified in one place.
  const shared = [...declaredCollections(args.appBlockId, args.manifest)]
    .filter(([, decl]) => collectionNeedsPublishScope(decl))
    .map(([name]) => name);
  if (shared.length === 0) return { kind: 'not_authoritative' };

  const { getDocStoreLookup } = await import('~/server/services/apps/doc-store-lookup.instance');
  let matches;
  try {
    matches = await getDocStoreLookup().findSharedByKey(args.appBlockId, shared, args.key);
  } catch (err) {
    // No store here: fall back to the legacy store. Unconfigured is expected (dev, previews);
    // a configured store that refuses (its role bypasses RLS) re-opens the legacy fallback for
    // an app that has moved, so that one is logged.
    if (isDocStoreError(err, 'storage_disabled')) {
      const { appdataDb } = await import('~/server/db/appdataDb');
      if (appdataDb) {
        const { logToAxiom } = await import('~/server/logging/client');
        logToAxiom(
          {
            name: 'app-shared-item-doc-store-disabled',
            type: 'error',
            message: err.message,
            appBlockId: args.appBlockId,
          },
          'app-blocks'
        ).catch(() => undefined);
      }
      return { kind: 'not_authoritative' };
    }
    throw err;
  }
  if (matches.length > 1) return { kind: 'ambiguous' };
  if (matches.length === 1) return { kind: 'found', ...matches[0] };
  return { kind: 'none' };
}

type LegacyItem = { authorUid: number; hidden: boolean };

/** The legacy row under `key`, hidden or not. Throws when the apps datastore cannot be read. */
async function readLegacySharedItem(blockId: string, key: string): Promise<LegacyItem | null> {
  const { sanitizeAppSlug, appSchemaIdent } = await import('~/server/utils/apps-slug');
  const slug = sanitizeAppSlug(blockId);
  if (!slug) return null;
  const { requireAppsDb } = await import('~/server/db/appsDb');
  const row = (
    await requireAppsDb().query<{ author_user_id: number; hidden: boolean }>(
      `SELECT author_user_id, hidden_at IS NOT NULL AS hidden FROM ${appSchemaIdent(
        slug
      )}.shared_kv WHERE key = $1 LIMIT 1`,
      [key]
    )
  ).rows[0];
  return row ? { authorUid: row.author_user_id, hidden: row.hidden } : null;
}
