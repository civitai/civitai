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
// DARK. Declaring `keyedBy` waits on the `viewerKeyedDocs` feature switch
// (`APP_STORAGE_ENABLED_FEATURES`). Every `@me` op refuses `503` while the secret is unset (there
// is no fallback key). Writes to a collection wait on its own Flipt switch in production (below).
import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { AppStorageKeyedBy } from '~/shared/constants/block-storage.constants';

/** The path segment, after a collection, that names the viewer's own document. Not a key: `@`. */
export const VIEWER_KEYED_SEGMENT = '@me';

/** A parent key: the store's key grammar without `:`, at most 96 characters, not only dots. */
export const VIEWER_KEY_PARENT_RE = /^[A-Za-z0-9._-]{1,96}$/;
const DOT_ONLY = /^\.+$/;

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

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. */
function base32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

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
  const d = base32(mac.subarray(0, 16));
  return t.mode === 'parent+viewer' ? `${t.parent}:${d}` : d;
}

/** The derivation secret, or a `503`: never a fallback key. Blank reads as unset. */
function derivationSecret(): string {
  const secret = env.APP_STORAGE_VIEWER_KEY_SECRET?.trim();
  if (!secret) {
    throw new DocStoreError('service_unavailable', 'viewer-keyed documents are not configured', {
      reason: 'viewer_keys_unconfigured',
    });
  }
  return secret;
}

/**
 * Whether viewers may write the viewer-keyed collection `collection` (its migration switch, the
 * Flipt flag `app-blocks-storage-viewer-keyed-open`, evaluated per app with the collection as
 * context). Production only: a development or review namespace holds no migrated data, so it is
 * always open there. Flipt unreachable reads as closed.
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
 * Refuses a create, or a write BY KEY, to a viewer-keyed collection (`400`, `viewer_keyed`): its
 * keys are the server's to derive, so the only writes are the `@me` ones.
 */
export function refuseRawKeyWrite(coll: DocCollection): void {
  if (coll.config.keyedBy === undefined) return;
  throw refuse(
    'viewer_keyed',
    `collection ${coll.name} is viewer-keyed: write the viewer's own document at /${coll.name}/${VIEWER_KEYED_SEGMENT}`,
    coll.name
  );
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
    if (!VIEWER_KEY_PARENT_RE.test(parent) || DOT_ONLY.test(parent)) {
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
