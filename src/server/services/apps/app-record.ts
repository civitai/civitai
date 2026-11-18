/**
 * App Storage RECORD CORE: one shape for a piece of app data, whichever surface stores it, so
 * the data can say who owns it and travel with them.
 *
 *   { urn, owner, writer, collection, schemas, rev, body }
 *
 *   - `owner`:  who the data belongs to ({@link RecordOwner}), decided by {@link recordOwner}
 *               from the collection's declared policy. The ONE place that policy table lives.
 *   - `writer`: the app (and version, when the caller knows it) that wrote the record.
 *   - `schemas`: every major of its collection the body satisfies. Not decided here: the caller
 *               passes the registry feed's claimer (`createClaimer` in `doc-feed.ts`), so the
 *               majors rule (`storage-schema-majors.ts`) has one implementation.
 *   - `rev`:    the registry feed's `docRev`, so a record and the feed's entity for the same
 *               document carry the same rev.
 *   - `body`:   small structured data, at most {@link APP_RECORD_BODY_MAX_BYTES}. Large content is
 *               a URL reference inside the body, never inline.
 *
 * A PRIVATE record's URN carries the owner's HANDLE (`owned-document` in `urn.ts`): a private
 * collection is one key space per user, so the key alone is not unique. The handle is a keyed
 * pseudonym of the user id, the same in every app, so one user's records join on URN without the
 * URN telling anyone the user id. A SHARED record (one key space per app) keeps exactly the
 * document URN the registry feed already publishes, whoever owns it: a published URN is never
 * rewritten.
 *
 * 🔴 SWITCHED OFF, AND NOTHING CALLS IT. Everything that needs the handle key takes an
 * {@link AppRecordConfig}, and the only way to get one is {@link appRecordConfig}, which returns
 * null unless `APP_RECORD_CORE_ENABLED` is on and `APP_RECORD_OWNER_HANDLE_KEY` is set. No live
 * path imports this module yet.
 *
 * Pure: no database, no clock, no env read (the caller passes the env values in).
 */
import { createHmac } from 'crypto';
import { docRev } from '~/server/registry-adapter/doc-feed';
import { registryUrn } from '~/server/registry-adapter/urn';
import type { DocRecord } from '~/server/services/apps/doc-store.types';
import { DOC_STORE_BOUNDS } from '~/server/services/apps/doc-store.types';
import type { DeclaredStorageCollection } from '~/shared/constants/block-storage.constants';

/**
 * Who a record belongs to.
 *   - `user`:      a person; portable with them.
 *   - `app`:       the app itself (data only its owner writes).
 *   - `nobody`:    an aggregate (counters and marks); not portable.
 */
export type RecordOwner = { kind: 'user'; userId: number } | { kind: 'app' } | { kind: 'nobody' };

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
/** The switch on and the handle key present. Only {@link appRecordConfig} makes one. */
export type AppRecordConfig = { readonly handleKey: string; readonly [configBrand]: true };

/** The shortest handle key accepted: 32 bytes, the HMAC-SHA256 output size. */
export const APP_RECORD_HANDLE_KEY_MIN_BYTES = 32;

/**
 * The record core's config from the server env values, or null while it is switched off (the
 * default) or has no key. A key that is set but shorter than
 * {@link APP_RECORD_HANDLE_KEY_MIN_BYTES} throws: a weak key must not quietly mint handles.
 */
export function appRecordConfig(env: {
  APP_RECORD_CORE_ENABLED?: boolean;
  APP_RECORD_OWNER_HANDLE_KEY?: string;
}): AppRecordConfig | null {
  if (env.APP_RECORD_CORE_ENABLED !== true) return null;
  const key = env.APP_RECORD_OWNER_HANDLE_KEY;
  if (!key) return null;
  if (Buffer.byteLength(key, 'utf8') < APP_RECORD_HANDLE_KEY_MIN_BYTES) {
    throw new Error(
      `app record: APP_RECORD_OWNER_HANDLE_KEY must be at least ${APP_RECORD_HANDLE_KEY_MIN_BYTES} bytes`
    );
  }
  return { handleKey: key } as AppRecordConfig;
}

// Domain separation: a digest the same key makes for any other purpose, over a message without
// this prefix, is never a handle.
const HANDLE_CONTEXT = 'app-record-owner-handle:v1:';
const HANDLE_BYTES = 16;

/**
 * A user's owner handle: HMAC-SHA256 under the handle key of `app-record-owner-handle:v1:<id>`,
 * its first 16 bytes in unpadded base64url. Always 22 characters, the same for a user in every
 * app, and it does not reveal the id without the key.
 */
export function ownerHandle(config: AppRecordConfig, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error(`app record: invalid user id ${userId}`);
  }
  return createHmac('sha256', config.handleKey)
    .update(`${HANDLE_CONTEXT}${userId}`)
    .digest()
    .subarray(0, HANDLE_BYTES)
    .toString('base64url');
}

/** The collection policy the owner depends on: who reads it and who writes it. */
export type RecordOwnerPolicy = Pick<DeclaredStorageCollection, 'kind' | 'visibility' | 'write'>;

/**
 * A document-store row as the record core reads it: `scopeUid` is the row's `scope_uid`, and
 * `lastWriterUid` its `last_writer_uid` (who wrote it last). `author` is who created it.
 */
export type RecordSourceRow = Pick<DocRecord, 'key' | 'data' | 'version' | 'author'> & {
  scopeUid: number;
  lastWriterUid: number | null;
};

/**
 * 🔴 THE OWNER POLICY TABLE. Every surface that turns stored app data into a record decides its
 * owner here and nowhere else.
 *
 *   visibility | write    | owner
 *   -----------+----------+-------------------------------------------------------
 *   private    | (none)   | user: the row's scope (`scope_uid`), for docs and logs
 *   shared     | own      | user: the document's author (its creator)
 *   shared     | anyone   | user: the document's creator, fixed at creation
 *   shared     | owner    | app
 *   shared     | none     | nobody (an aggregate of counters and marks)
 *
 * Under `anyone` other users may edit the document, and the owner stays its creator: who wrote
 * it last (`lastWriterUid`) never decides the owner, under any policy. An absent `write` on a
 * shared collection reads as `own`, as the store reads it. A counter document in a shared
 * collection (created empty by an increment, `author.kind: 'counter'`) is nobody's whatever the
 * write policy, as the store treats it (nobody may delete it). Under `own` and `anyone` a
 * document the app created is the app's. A row that contradicts its collection (a private row
 * with no user scope, a shared row with one) throws.
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
  if (row.author.kind === 'counter') return { kind: 'nobody' };
  const write = policy.write ?? 'own';
  switch (write) {
    case 'own':
    case 'anyone':
      return row.author.kind === 'user'
        ? { kind: 'user', userId: row.author.uid }
        : { kind: 'app' };
    case 'owner':
      return { kind: 'app' };
    case 'none':
      return { kind: 'nobody' };
  }
}

/** The registry feed's claimer for one collection family: the majors a body satisfies. */
export type RecordSchemaClaim = (data: unknown) => string[];

/**
 * The record of one stored document. `claim` is the collection family's claimer from the feed
 * (`createClaimer()(family, familyDigest(family))`). A private record's URN carries the
 * scope user's handle; a shared record's is the document URN the feed already publishes, whatever
 * its owner.
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
  const { slug, collection, policy, row, writer, claim } = input;
  assertRecordBodySize(row.data);
  const owner = recordOwner(policy, row);
  // The URN shape depends on visibility only, never on the owner: a private collection is one
  // key space per user, so its URN needs the owner's handle to be unique; a shared collection is
  // one key space per app, and its documents keep the URN the registry feed already publishes
  // (`doc-feed.ts`, the same builder), since a published URN is never rewritten.
  const urn =
    policy.visibility === 'private'
      ? registryUrn({
          kind: 'owned-document',
          slug,
          collection,
          handle: ownerHandle(config, row.scopeUid),
          key: row.key,
        })
      : registryUrn({ kind: 'document', slug, collection, key: row.key });
  const schemas = claim(row.data);
  return {
    urn,
    owner,
    writer,
    collection,
    schemas,
    rev: docRev(row, schemas),
    body: row.data,
  };
}
