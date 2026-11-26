/**
 * App Storage RECORD CORE: one shape for a piece of app data, whichever surface stores it, so
 * the data can say who owns it and travel with them.
 *
 *   { urn, owner, writer, collection, schemas, rev, body }
 *
 *   - `urn`:    `urn:apps.civitai.com:<slug>/<coll>/<id>`, the registry's `document` URN
 *               (`registryUrn` in `urn.ts`, the builder the feed uses). No URN names an owner.
 *               A shared record's `<id>` is its document key: exactly the URN the registry feed
 *               already publishes, and a published URN is never rewritten. A private record's
 *               `<id>` is the row's stored random `record_id`: a private collection is one key
 *               space per user, so its keys are not unique within the collection.
 *   - `owner`:  who the data belongs to ({@link RecordOwner}), decided by {@link recordOwner}.
 *               The ONE place that rule lives. Ownership is carried by this field only.
 *   - `writer`: the app (and version, when the caller knows it) that wrote the record.
 *   - `schemas`: every major of its collection the body satisfies. Not decided here: the caller
 *               passes the registry feed's claimer (`createClaimer` in `doc-feed.ts`), so the
 *               majors rule (`storage-schema-majors.ts`) has one implementation.
 *   - `rev`:    the registry feed's `docRev`, so a record and the feed's entity for the same
 *               document carry the same rev.
 *   - `body`:   small structured data, at most {@link APP_RECORD_BODY_MAX_BYTES}. Large content is
 *               a URL reference inside the body, never inline.
 *
 * 🔴 SWITCHED OFF BY DEFAULT. {@link toAppRecord} takes an {@link AppRecordConfig}, and the only
 * way to get one is {@link appRecordConfig}, which returns null unless `APP_RECORD_CORE_ENABLED`
 * is on. What the switch turns on: the record export (`appStorage.exportMine`,
 * `doc-store-viewer-usage.service.ts`), its only caller. Off, that route is NOT_FOUND.
 *
 * Pure: no database, no clock, no env read (the caller passes the env value in).
 */
import { docRev } from '~/server/registry-adapter/doc-feed';
import { registryUrn } from '~/server/registry-adapter/urn';
import type { DocRecord } from '~/server/services/apps/doc-store.types';
import { DOC_STORE_BOUNDS } from '~/server/services/apps/doc-store.types';
import type { DeclaredStorageCollection } from '~/shared/constants/block-storage.constants';

/**
 * Who a record belongs to.
 *   - `user`:   a person; portable with them.
 *   - `app`:    the app itself (documents the app created, and any document no user authored).
 */
export type RecordOwner = { kind: 'user'; userId: number } | { kind: 'app' };

export type AppRecordWriter = { app: string; version: string | null };

export type AppRecord = {
  urn: string;
  owner: RecordOwner;
  writer: AppRecordWriter;
  collection: string;
  schemas: string[];
  rev: string;
  body: Record<string, unknown>;
};

/**
 * The bound on a record's body: the bytes of its JSON serialization (UTF-8). It IS the document
 * store's per-document cap (`DOC_STORE_BOUNDS.docBytes`, the `doc_size_cap` CHECK), measured the
 * way the store's own write path measures it, so every stored document fits a record and no
 * second limit exists.
 */
export const APP_RECORD_BODY_MAX_BYTES = DOC_STORE_BOUNDS.docBytes;

/** The UTF-8 bytes of `body`'s JSON serialization. */
export function recordBodyBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

/** Throws when `body` is over {@link APP_RECORD_BODY_MAX_BYTES}; at the limit is allowed. */
export function assertRecordBodySize(body: unknown): void {
  const bytes = recordBodyBytes(body);
  if (bytes > APP_RECORD_BODY_MAX_BYTES) {
    throw new Error(
      `app record: body is ${bytes} bytes, over the ${APP_RECORD_BODY_MAX_BYTES}-byte limit`
    );
  }
}

declare const configBrand: unique symbol;
/** Proof the switch is on. Only {@link appRecordConfig} makes one. */
export type AppRecordConfig = { readonly [configBrand]: true };

/** The record core's config from the server env, or null while it is switched off (the default). */
export function appRecordConfig(env: {
  APP_RECORD_CORE_ENABLED?: boolean;
}): AppRecordConfig | null {
  if (env.APP_RECORD_CORE_ENABLED !== true) return null;
  return {} as AppRecordConfig;
}

/** The collection declaration a record is built under. */
export type RecordOwnerPolicy = Pick<DeclaredStorageCollection, 'kind' | 'visibility' | 'write'>;

/**
 * A document-store row as the record core reads it: `scopeUid` is the row's `scope_uid`,
 * `lastWriterUid` its `last_writer_uid` (who wrote it last) and `recordId` its `record_id` (a
 * random uuid; null on a row written before the column existed and not yet backfilled). `author`
 * is who created it.
 */
export type RecordSourceRow = Pick<DocRecord, 'key' | 'data' | 'version' | 'author'> & {
  scopeUid: number;
  lastWriterUid: number | null;
  recordId: string | null;
};

/**
 * 🔴 THE OWNER RULE. Every surface that turns stored app data into a record decides its owner
 * here and nowhere else.
 *
 *   visibility | created by          | owner
 *   -----------+---------------------+-----------------------------------------------
 *   private    | (anyone)            | user: the row's scope (`scope_uid`), docs and logs
 *   shared     | a user              | user: that user, under every write policy
 *   shared     | the app             | app
 *
 * A shared document's owner is its creator, fixed at creation, whatever the collection's write
 * policy (`own`, `anyone`, `owner`, `none`) and whatever it was when the document was written:
 * the same rule as the store's account wipe, which removes exactly the documents a user authored
 * (`author_kind = 'user' AND author_uid`, `doc-store.ts`). Who wrote it last (`lastWriterUid`)
 * never decides the owner. A row that contradicts its collection (a private row with no user
 * scope, a shared row with one) throws.
 */
export function recordOwner(policy: RecordOwnerPolicy, row: RecordSourceRow): RecordOwner {
  if (policy.visibility === 'private') {
    if (!Number.isSafeInteger(row.scopeUid) || row.scopeUid < 1) {
      throw new Error(`app record: private row ${row.key} has no user scope`);
    }
    return { kind: 'user', userId: row.scopeUid };
  }
  if (row.scopeUid !== 0) {
    throw new Error(`app record: shared row ${row.key} has a user scope`);
  }
  switch (row.author.kind) {
    case 'user':
      return { kind: 'user', userId: row.author.uid };
    case 'app':
      return { kind: 'app' };
  }
}

// How Postgres prints a uuid: lowercase, hyphenated. One spelling, so one URN per record.
const RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The registry feed's claimer for one collection family: the majors a body satisfies. */
export type RecordSchemaClaim = (data: unknown) => string[];

/**
 * The record of one stored document. `claim` is the collection family's claimer from the feed
 * (`createClaimer()(family, familyDigest(family))`). Throws on a private row with no
 * `record_id`, or a malformed one, rather than inventing an id.
 */
export function toAppRecord(
  config: AppRecordConfig,
  input: {
    slug: string;
    collection: string;
    policy: RecordOwnerPolicy;
    row: RecordSourceRow;
    writer: AppRecordWriter;
    claim: RecordSchemaClaim;
  }
): AppRecord {
  // The type already requires a config; this refuses an untyped caller that passes null.
  if (!config) throw new Error('app record: the record core is switched off');
  const { slug, collection, policy, row, writer, claim } = input;
  assertRecordBodySize(row.data);
  const owner = recordOwner(policy, row);
  let id = row.key;
  if (policy.visibility === 'private') {
    if (row.recordId === null) {
      throw new Error(`app record: private row ${row.key} has no record_id`);
    }
    if (!RECORD_ID_RE.test(row.recordId)) {
      throw new Error(`app record: private row ${row.key} has a malformed record_id`);
    }
    id = row.recordId;
  }
  const schemas = claim(row.data);
  return {
    urn: registryUrn({ kind: 'document', slug, collection, key: id }),
    owner,
    writer,
    collection,
    schemas,
    rev: docRev(row, schemas),
    body: row.data,
  };
}
