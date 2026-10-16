// Resolve an app-supplied shared item KEY to the published item it names, for server code that
// checks one by key: App Store sub-listings (author + hidden) and spend attribution (author).
// An app's shared items live in the App Blocks document store, in its legacy per-app shared
// storage (`app_<slug>.shared_kv`), or — while it moves between them — in both under one key.
//
// Document store: production namespace only, so a dev or review document never resolves; only
// the collections the APPROVED manifest declares shared are probed, so an app with none costs
// no document-store query.
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

export type SharedItem =
  | { kind: 'found'; authorUid: number | null; hidden: boolean }
  /**
   * The key does not name one item: more than one declared shared collection holds it (the
   * store's primary key includes the collection), or the two stores name different authors.
   */
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * The item `key` names, hidden included. The document store decides when it holds the key; the
 * legacy store is the fallback otherwise. A document is accepted only if a legacy row under the
 * same key, if any, has the same author.
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
  if (doc.kind === 'ambiguous') return doc;
  if (doc.kind === 'absent') {
    const legacy = await readLegacySharedItem(args.blockId, args.key);
    return legacy ? { kind: 'found', ...legacy } : { kind: 'none' };
  }
  // A document under a legacy item's key must be that item (copied, same author), not another
  // user's document that took the key.
  const legacy = await readLegacySharedItemIfProvisioned(args.blockId, args.key);
  if (legacy && legacy.authorUid !== doc.authorUid) return { kind: 'ambiguous' };
  return { kind: 'found', authorUid: doc.authorUid, hidden: doc.hidden || !!legacy?.hidden };
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

/**
 * The legacy row, for the cross-check of a document hit: null where there can be none (no apps
 * datastore in this environment, or the app has no legacy schema). Any other failure throws —
 * it cannot prove the row is absent.
 */
async function readLegacySharedItemIfProvisioned(
  blockId: string,
  key: string
): Promise<LegacyItem | null> {
  const { appsDb } = await import('~/server/db/appsDb');
  if (!appsDb) return null;
  try {
    return await readLegacySharedItem(blockId, key);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    // undefined_table / invalid_schema_name: never provisioned, so no legacy row.
    if (code === '42P01' || code === '3F000') return null;
    throw err;
  }
}
