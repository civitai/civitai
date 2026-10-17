import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import { isAllocationFailure, type CoocSql } from '~/server/services/resource-intent-cooc/store';
import type { TagBuildStats } from './build';
import { TagIndexDecodeUnavailableError } from './decode-errors';
import { decodeTagIndex, TAG_INDEX_MAX_PAYLOAD_BYTES, type DecodedTagIndex } from './payload';
import type { TagIndex } from './score';

/**
 * `ResourceIntentTagIndexSnapshot` storage: the payload in object storage under a content-addressed
 * key, and a manifest row inserted only after the upload succeeded.
 */

/**
 * Object storage as the store needs it. `get` returns the bytes and their sha256; it may refuse early
 * when the object is not `expectedBytes` long, and stops (rejecting) once `signal` aborts.
 */
export type TagIndexObjectStore = {
  prefix: string;
  put: (key: string, bytes: Buffer) => Promise<void>;
  get: (
    key: string,
    expectedBytes: number,
    signal?: AbortSignal
  ) => Promise<{ bytes: Buffer; sha256: string }>;
};

/** One stored object as a listing reports it. */
export type TagIndexObjectInfo = { key: string; lastModified: Date; bytes: number };

/** Object storage as retention needs it: the store's operations, plus listing and deleting. */
export type TagIndexObjectSweeper = TagIndexObjectStore & {
  /** Every object under `${prefix}/`. */
  list: () => AsyncIterable<TagIndexObjectInfo>;
  /** Deletes one snapshot object; refuses a key that is not `${prefix}/<64 hex>`. */
  delete: (key: string) => Promise<void>;
};

/**
 * `decode`: how `loadManifestSnapshot` decodes a loaded payload; `decodeTagIndex` (on the calling
 * thread) unless given. The serving holder passes the worker-thread decoder, which takes the
 * payload's buffer. `putSnapshot` ignores it and always decodes on the calling thread, since it still
 * needs the bytes afterwards.
 */
export type TagIndexStoreDeps = {
  sql: CoocSql;
  objects: TagIndexObjectStore;
  decode?: (payload: Uint8Array, signal?: AbortSignal) => Promise<DecodedTagIndex>;
};

export type TagIndexSnapshotManifest = {
  id: string;
  status: string;
  vocabVersion: string;
  specHash: string;
  payloadSha256: string;
  payloadBytes: number;
  objectKey: string;
  buildStats: TagBuildStats;
  createdAt: Date;
  retiredAt: Date | null;
};

/**
 * A payload or stored snapshot refused as given: retrying fails the same way until the payload, the
 * row, its object or its vocabulary changes.
 */
export class TagIndexSnapshotUnservableError extends Error {}
export class TagIndexObjectMissingError extends TagIndexSnapshotUnservableError {}
export class TagIndexVocabularyMissingError extends TagIndexSnapshotUnservableError {}
export class TagIndexVocabularyNotFrozenError extends TagIndexSnapshotUnservableError {}
export class TagIndexPayloadSizeError extends TagIndexSnapshotUnservableError {}
export class TagIndexPayloadHashError extends TagIndexSnapshotUnservableError {}
/** The bytes do not decode to a valid index. */
export class TagIndexPayloadCorruptError extends TagIndexSnapshotUnservableError {}
export class TagIndexSpecHashMismatchError extends TagIndexSnapshotUnservableError {}
export class TagIndexVocabVersionMismatchError extends TagIndexSnapshotUnservableError {}

export { TagIndexDecodeUnavailableError };

/**
 * The upload succeeded and the manifest insert did not. The object is left where it is: no row names
 * it, so nothing loads it, and putting the same payload again re-uploads the same key and inserts.
 * It is never deleted here, because a ready row may already name that key (identical bytes).
 */
export class TagIndexManifestInsertError extends Error {
  constructor(readonly objectKey: string, cause: unknown) {
    super(
      `tag index object ${objectKey} uploaded but its manifest row was not inserted: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const tagIndexObjectKey = (prefix: string, sha256: string) => `${prefix}/${sha256}`;

/** Whether `key` is a snapshot object key under `prefix`: `${prefix}/` and a lowercase sha256. */
export const isTagIndexObjectKey = (prefix: string, key: string) =>
  key.length === prefix.length + 65 &&
  key.startsWith(`${prefix}/`) &&
  /^[0-9a-f]{64}$/.test(key.slice(prefix.length + 1));

const T = Prisma.raw('"ResourceIntentTagIndexSnapshot"');
const COLUMNS = Prisma.raw(
  `"id", "status", "vocabVersion", "specHash", "payloadSha256", "payloadBytes", "objectKey",
   "buildStats", "createdAt", "retiredAt"`
);

async function vocabularyStatus(sql: CoocSql, vocabVersion: string): Promise<string | null> {
  const [row] = await sql.query<{ status: string }>(Prisma.sql`
    SELECT "status" FROM "ResourceIntentVocabulary" WHERE "vocabVersion" = ${vocabVersion}`);
  return row?.status ?? null;
}

async function decodeOrCorrupt(
  payload: Uint8Array,
  what: string,
  decode: (payload: Uint8Array, signal?: AbortSignal) => Promise<DecodedTagIndex> = decodeTagIndex,
  signal?: AbortSignal
): Promise<DecodedTagIndex> {
  try {
    return await decode(payload, signal);
  } catch (e) {
    // Out of memory, or no decoder, not bad bytes: a later attempt can pass.
    if (isAllocationFailure(e) || e instanceof TagIndexDecodeUnavailableError) throw e;
    throw new TagIndexPayloadCorruptError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assertHeader(
  decoded: DecodedTagIndex,
  expect: { specHash: string; vocabVersion: string },
  what: string
) {
  if (decoded.specHash !== expect.specHash)
    throw new TagIndexSpecHashMismatchError(
      `${what}: payload specHash ${decoded.specHash}, expected ${expect.specHash}`
    );
  if (decoded.vocabVersion !== expect.vocabVersion)
    throw new TagIndexVocabVersionMismatchError(
      `${what}: payload vocabVersion ${decoded.vocabVersion}, expected ${expect.vocabVersion}`
    );
}

export type PutTagIndexSnapshotMeta = {
  vocabVersion: string;
  specHash: string;
  buildStats: TagBuildStats;
};

/**
 * Store a snapshot: refuse a vocabulary that is missing or not frozen, and any payload that does not
 * decode or whose header disagrees with `meta`; upload it; then insert the manifest. A ready row with
 * the same bytes already standing is returned with `created: false`.
 */
export async function putSnapshot(
  deps: TagIndexStoreDeps,
  payload: Buffer,
  meta: PutTagIndexSnapshotMeta
): Promise<{ manifest: TagIndexSnapshotManifest; created: boolean }> {
  const { sql, objects } = deps;
  if (payload.length === 0 || payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new TagIndexPayloadSizeError(
      `tag index payload is ${payload.length} bytes; allowed 1..${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  const vocabStatus = await vocabularyStatus(sql, meta.vocabVersion);
  if (vocabStatus === null)
    throw new TagIndexVocabularyMissingError(`vocabulary ${meta.vocabVersion} not found`);
  if (vocabStatus !== 'frozen')
    throw new TagIndexVocabularyNotFrozenError(
      `a snapshot needs a frozen vocabulary; ${meta.vocabVersion} is '${vocabStatus}'`
    );
  assertHeader(await decodeOrCorrupt(payload, 'tag index payload'), meta, 'tag index payload');

  const payloadSha256 = sha256Hex(payload);
  const objectKey = tagIndexObjectKey(objects.prefix, payloadSha256);
  await objects.put(objectKey, payload);

  const buildStats = JSON.stringify(meta.buildStats);
  let inserted: TagIndexSnapshotManifest | undefined;
  try {
    [inserted] = await sql.query<TagIndexSnapshotManifest>(Prisma.sql`
      INSERT INTO ${T} ("vocabVersion", "specHash", "payloadSha256", "payloadBytes", "objectKey",
        "buildStats")
      VALUES (${meta.vocabVersion}, ${meta.specHash}, ${payloadSha256}, ${payload.length},
        ${objectKey}, ${buildStats}::jsonb)
      ON CONFLICT ("payloadSha256") WHERE "status" = 'ready' DO NOTHING
      RETURNING ${COLUMNS}`);
  } catch (e) {
    throw new TagIndexManifestInsertError(objectKey, e);
  }
  if (inserted) return { manifest: inserted, created: true };

  const [existing] = await sql.query<TagIndexSnapshotManifest>(Prisma.sql`
    SELECT ${COLUMNS} FROM ${T}
    WHERE "payloadSha256" = ${payloadSha256} AND "status" = 'ready'`);
  if (!existing)
    throw new TagIndexManifestInsertError(
      objectKey,
      new Error('a ready row with this payload conflicted and is gone')
    );
  return { manifest: existing, created: false };
}

/** The newest ready manifest built under `specHash`, other than those in `exceptIds`. */
export async function latestReadyManifest(
  sql: CoocSql,
  specHash: string,
  exceptIds: readonly string[] = []
): Promise<TagIndexSnapshotManifest | null> {
  const except = exceptIds.length
    ? Prisma.sql`AND "id" <> ALL(${[...exceptIds]}::text[])`
    : Prisma.empty;
  const [row] = await sql.query<TagIndexSnapshotManifest>(Prisma.sql`
    SELECT ${COLUMNS} FROM ${T}
    WHERE "specHash" = ${specHash} AND "status" = 'ready' ${except}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT 1`);
  return row ?? null;
}

/**
 * Download and decode the snapshot a manifest names. Refuses, each with its own error: a vocabulary
 * that is a candidate; an object that is gone; bytes of another length or sha256 than the manifest's
 * (checked before decoding); bytes that do not decode; a header whose specHash or vocabVersion is not
 * the manifest's. Any other download failure, or running out of memory while decoding, is rethrown
 * as it is, and so is a decoder that was unavailable (`TagIndexDecodeUnavailableError`). `signal`
 * stops the download and the decode; the rejection then is not a refusal of the snapshot.
 */
export async function loadManifestSnapshot(
  deps: TagIndexStoreDeps,
  manifest: TagIndexSnapshotManifest,
  signal?: AbortSignal
): Promise<{ manifest: TagIndexSnapshotManifest; index: TagIndex }> {
  const what = `tag index snapshot ${manifest.id}`;
  if ((await vocabularyStatus(deps.sql, manifest.vocabVersion)) === 'candidate')
    throw new TagIndexVocabularyNotFrozenError(
      `${what}: vocabulary ${manifest.vocabVersion} is a candidate`
    );
  const { bytes, sha256 } = await deps.objects.get(
    manifest.objectKey,
    manifest.payloadBytes,
    signal
  );
  if (bytes.length !== manifest.payloadBytes)
    throw new TagIndexPayloadSizeError(
      `${what}: ${bytes.length} bytes, manifest says ${manifest.payloadBytes}`
    );
  if (sha256 !== manifest.payloadSha256)
    throw new TagIndexPayloadHashError(`${what}: sha256 does not match the manifest`);
  signal?.throwIfAborted();
  const decoded = await decodeOrCorrupt(bytes, what, deps.decode, signal);
  assertHeader(decoded, manifest, what);
  return { manifest, index: decoded.index };
}

/** The newest ready snapshot for `specHash`, verified and decoded; `null` when there is none. */
export async function loadLatestSnapshot(
  deps: TagIndexStoreDeps,
  specHash: string
): Promise<{ manifest: TagIndexSnapshotManifest; index: TagIndex } | null> {
  const manifest = await latestReadyManifest(deps.sql, specHash);
  return manifest ? loadManifestSnapshot(deps, manifest) : null;
}
