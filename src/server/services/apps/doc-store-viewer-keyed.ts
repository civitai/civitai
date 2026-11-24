// VIEWER-KEYED DOCUMENTS (`docs/app-storage-generic-core.md`, "Viewer-keyed documents"): a shared
// `write: "own"` collection declaring `keyedBy` has its document keys derived by the server from
// the verified viewer, plus a parent key the client names under `parent+viewer`. The REST layer
// (`doc-store-api.ts`) serves them at `/:c/@me[/:parent]` and turns each into the ordinary get,
// put or delete at the derived key, so every platform policy applies as to any shared document.
//
// THE KEY. `d` = the first 128 bits of HMAC-SHA256, under the server-held derivation secret, over
// the length-prefixed tuple (app id, namespace, collection, mode, parent or "", viewer user id),
// as 26 characters of lowercase RFC 4648 base32 without padding. The key is `d` (`viewer`) or
// `<parent>:<d>` (`parent+viewer`): at most 96 + 1 + 26 = 123 characters, inside the store's key
// grammar. The parent grammar has no `:`, so `keyPrefix=<parent>:` lists exactly one parent's.
// Keyed, not a plain hash: user ids are small integers, so an unkeyed hash of one is reversed by
// hashing every id. What the secret protects is unlinkability only: authorization never depends
// on it (the viewer comes from the verified token, and raw-key writes here are refused).
//
// Keys need APP_STORAGE_VIEWER_KEY_SECRET: while it is unset, an `@me` op answers 503 once its
// other checks pass. In production, writes also need the collection's Flipt switch, which fails
// closed (`isViewerKeyedOpen`).
import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { PUBLISHED_NS, refuseViewerKeyed } from '~/server/services/apps/doc-store';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DocStoreError, isViewerKeyParent } from '~/server/services/apps/doc-store.types';
import { base32Encode } from '~/server/utils/base32';
import type { AppStorageKeyedBy } from '~/shared/constants/block-storage.constants';

/** The path segment, after a collection, that names the viewer's own document. Not a key: `@`. */
export const VIEWER_KEYED_SEGMENT = '@me';

/** Why a viewer-keyed request was refused, in `details.reason` of a `400 invalid_request`. */
export type ViewerKeyedRefusal =
  | 'viewer_keyed'
  | 'parent_required'
  | 'parent_not_allowed'
  | 'invalid_parent'
  | 'not_viewer_keyed';

const refuse = (reason: ViewerKeyedRefusal, message: string, collection: string) =>
  new DocStoreError('invalid_request', message, { reason, collection });

export type ViewerKeyTuple = {
  appId: string;
  ns: string;
  collection: string;
  mode: AppStorageKeyedBy;
  /** The parent key under `parent+viewer`; null under `viewer`. */
  parent: string | null;
  viewerUid: number;
};

/** Each field as its UTF-8 bytes behind a 4-byte big-endian length, so no two tuples collide. */
function lengthPrefixed(fields: readonly string[]): Buffer {
  return Buffer.concat(
    fields.flatMap((field) => {
      const bytes = Buffer.from(field, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(bytes.length);
      return [len, bytes];
    })
  );
}

/** The document key for one (app, namespace, collection, mode, parent, viewer). Pure. */
export function deriveViewerKey(secret: string, t: ViewerKeyTuple): string {
  const mac = createHmac('sha256', secret)
    .update(
      lengthPrefixed([t.appId, t.ns, t.collection, t.mode, t.parent ?? '', String(t.viewerUid)])
    )
    .digest();
  const d = base32Encode(mac.subarray(0, 16));
  return t.mode === 'parent+viewer' ? `${t.parent}:${d}` : d;
}

/** The derivation secret (trimmed), or null while it is unset or blank. */
function configuredSecret(): string | null {
  return env.APP_STORAGE_VIEWER_KEY_SECRET?.trim() || null;
}

/** The derivation secret, or a `503`: never a fallback key. Blank reads as unset. */
function derivationSecret(): string {
  const secret = configuredSecret();
  if (!secret) {
    throw new DocStoreError('service_unavailable', 'viewer-keyed documents are not configured', {
      reason: 'viewer_keys_unconfigured',
    });
  }
  return secret;
}

/**
 * The key deriver of one viewer-keyed collection, for the MARK MIGRATION
 * (`migrateMarksToDocs` in `storage-mark-migration.service.ts`): each copied vote lands at exactly
 * the key its voter's own `@me` call derives, so the voter reaches it after the switch opens.
 * Throws the `503` (`viewer_keys_unconfigured`) while the derivation secret is unset, as every
 * `@me` op does: a copy must never land at a key no viewer can reach.
 */
export function viewerKeyDeriver(args: {
  appId: string;
  ns: string;
  collection: string;
  mode: AppStorageKeyedBy;
}): (parent: string | null, viewerUid: number) => string {
  const secret = derivationSecret();
  return (parent, viewerUid) =>
    deriveViewerKey(secret, {
      appId: args.appId,
      ns: args.ns,
      collection: args.collection,
      mode: args.mode,
      parent: args.mode === 'parent+viewer' ? parent : null,
      viewerUid,
    });
}

/**
 * Whether viewers may write the viewer-keyed collection `collection`: the Flipt flag
 * `app-blocks-storage-viewer-keyed-open`, per app with the collection as context, created DEFAULT ON
 * with a closed segment listing the migration targets until each is verified. Fails closed: an
 * absent flag or an unreachable Flipt reads as closed. Production only: development and review
 * namespaces hold no migrated data and are always open.
 */
export async function isViewerKeyedOpen(
  ctx: DocStoreContext,
  collection: string
): Promise<boolean> {
  if (ctx.ns !== PUBLISHED_NS) return true;
  return isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_STORAGE_VIEWER_KEYED_OPEN, ctx.appId, {
    collection,
  });
}

/**
 * `open` in `GET /storage`: whether a `@me` write to `collection` can land at all, so false while
 * the derivation secret is unset as well as while the switch is closed.
 */
export async function isViewerKeyedWritable(
  ctx: DocStoreContext,
  collection: string
): Promise<boolean> {
  return configuredSecret() !== null && (await isViewerKeyedOpen(ctx, collection));
}

/**
 * The key of the viewer's own document for a `@me` op, refusing, in this order: a collection that
 * is not viewer-keyed, a parent missing, unwanted or outside its grammar (`400`); a write while
 * the collection's switch is closed (`403 write_policy`); and an unset derivation secret (`503`).
 * The caller has already refused an anonymous viewer (`401 sign_in_required`).
 */
export async function viewerKeyedDocKey(args: {
  ctx: DocStoreContext;
  coll: DocCollection;
  parent: string | null;
  write: boolean;
}): Promise<string> {
  const { ctx, coll, parent } = args;
  const mode = coll.config.keyedBy;
  if (mode === undefined) {
    throw refuse(
      'not_viewer_keyed',
      `collection ${coll.name} is not viewer-keyed: address its documents by key`,
      coll.name
    );
  }
  if (mode === 'viewer' && parent !== null) {
    throw refuse(
      'parent_not_allowed',
      `collection ${coll.name} is keyed by viewer only: use /${coll.name}/${VIEWER_KEYED_SEGMENT}`,
      coll.name
    );
  }
  if (mode === 'parent+viewer') {
    if (parent === null) {
      throw refuse(
        'parent_required',
        `collection ${coll.name} is keyed by parent and viewer: use /${coll.name}/${VIEWER_KEYED_SEGMENT}/:parent`,
        coll.name
      );
    }
    if (!isViewerKeyParent(parent)) {
      throw refuse(
        'invalid_parent',
        'parent must be 1–96 characters of [A-Za-z0-9._-], not only dots',
        coll.name
      );
    }
  }
  if (args.write && !(await isViewerKeyedOpen(ctx, coll.name))) {
    throw new DocStoreError('write_policy', 'this collection is not open for writes yet', {
      collection: coll.name,
      reason: 'viewer_keyed_closed',
    });
  }
  if (ctx.viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
  return deriveViewerKey(derivationSecret(), {
    appId: ctx.appId,
    ns: ctx.ns,
    collection: coll.name,
    mode,
    parent,
    viewerUid: ctx.viewerUid,
  });
}
