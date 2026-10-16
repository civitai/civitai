// Resolve an app-supplied shared item KEY to the published item it names, for server code that
// checks one by key: App Store sub-listings (author + hidden) and spend attribution (author).
// An app's shared items live in the App Blocks document store, in its legacy per-app shared
// storage (`app_<slug>.shared_kv`), or — while it moves between them — in both under one key.
// A move copies each item with its key, author and hidden state, so a document-store hit is read
// alone and the legacy row is never consulted for it.
//
// Document store: production namespace only, so a dev or review document never resolves; only
// the collections the APPROVED manifest declares shared are probed, so an app with none costs
// no document-store query.
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

export type SharedItem =
  | { kind: 'found'; authorUid: number | null; hidden: boolean }
  /**
   * More than one declared shared collection holds the key (the store's primary key includes
   * the collection), so the key does not name one item.
   */
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * The item `key` names, hidden included. A document-store hit decides on its own (the legacy
 * store is not read); the legacy store is the fallback only when the document store has none.
 *
 * A document deleted from the document store is not remembered: a legacy copy of it, if one
 * remains, resolves again (the store's tombstones are short-lived and carry no author).
 *
 * Throws when a store or the manifest cannot be read: the caller then cannot tell found from
 * missing. A document store that is not configured counts as empty.
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
  if (doc.kind !== 'absent') return doc;
  const legacy = await readLegacySharedItem(args.blockId, args.key);
  return legacy ? { kind: 'found', ...legacy } : { kind: 'none' };
}

type DocStoreResult =
  | { kind: 'found'; authorUid: number | null; hidden: boolean }
  | { kind: 'ambiguous' }
  | { kind: 'absent' };

async function findInDocStore(args: {
  appBlockId: string;
  manifest: unknown;
  key: string;
}): Promise<DocStoreResult> {
  const { declaredCollections } = await import('~/server/services/apps/doc-store-access');
  const shared = [...declaredCollections(args.appBlockId, args.manifest)]
    .filter(([, decl]) => decl.visibility === 'shared')
    .map(([name]) => name);
  if (shared.length === 0) return { kind: 'absent' };

  const { getDocStoreLookup } = await import('~/server/services/apps/doc-store-lookup.instance');
  let matches;
  try {
    matches = await getDocStoreLookup().findSharedByKey(args.appBlockId, shared, args.key);
  } catch (err) {
    // No store here (unconfigured, or a role that bypasses RLS): fall back to the legacy store.
    if (isDocStoreError(err, 'storage_disabled')) return { kind: 'absent' };
    throw err;
  }
  if (matches.length > 1) return { kind: 'ambiguous' };
  if (matches.length === 1) return { kind: 'found', ...matches[0] };
  return { kind: 'absent' };
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
