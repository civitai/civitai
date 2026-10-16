// Resolve an app-supplied shared item key against the App Blocks document store, for server
// code that checks a PUBLISHED item by key: App Store sub-listings (author + hidden) and spend
// attribution (author). Those callers read the legacy per-app shared store as well, and fall
// back to it only on `absent`, so an app that moved its shared data to the document store
// resolves there, and an app that has not moved keeps resolving from the legacy store.
//
// What it reads: the app's own documents (the server-derived AppBlock id, never a client value),
// in the production namespace only (`PUBLISHED_NS`; a dev or review namespace never resolves), in
// the collections its APPROVED manifest declares `shared`, with `scope_uid = 0`. Only declared
// collections are probed, so each probe is a primary-key lookup and an app that declares no
// shared collection costs no query at all.
import { isDocStoreError } from '~/server/services/apps/doc-store.types';

export type DocStoreSharedItem =
  /** Exactly one shared document holds the key. */
  | { kind: 'found'; authorUid: number | null; hidden: boolean }
  /**
   * More than one declared shared collection holds the key (the store's primary key includes
   * the collection), so the key alone does not say which item is meant. Callers refuse it.
   */
  | { kind: 'ambiguous' }
  /** No shared document holds the key, or this environment has no document store. */
  | { kind: 'absent' };

/**
 * Throws when the store or the manifest cannot be read (`DocStoreError` or a raw error): the
 * caller then cannot tell found from absent, and must not fall back to the legacy store.
 */
export async function resolveDocStoreSharedItem(args: {
  appBlockId: string;
  /** The app's approved manifest (`AppBlock.manifest`). */
  manifest: unknown;
  key: string;
}): Promise<DocStoreSharedItem> {
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
    // No store in this environment (or one it refuses, logged once by the instance): nothing
    // can be stored there, which is what the legacy fallback was for before the store existed.
    if (isDocStoreError(err, 'storage_disabled')) {
      return { kind: 'absent' };
    }
    throw err;
  }
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'found', authorUid: matches[0].authorUid, hidden: matches[0].hidden };
}
