import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import {
  assertCoocPin,
  isAllocationFailure,
  type CoocSnapshotKind,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import type { TagBuildStats } from './build';
import { decodeTagIndex, TAG_INDEX_MAX_PAYLOAD_BYTES, type DecodedTagIndex } from './payload';
import type { TagIndex } from './score';

/**
 * `ResourceIntentTagIndexSnapshot` storage: the payload in object storage under a content-addressed
 * key, and a manifest row inserted only after the upload succeeded.
 */

export type TagIndexSnapshotKind = CoocSnapshotKind;

/** Object storage as the store needs it; `get` may refuse early when the object's size is not `expectedBytes`. */
export type TagIndexObjectStore = {
  prefix: string;
  put: (key: string, bytes: Buffer) => Promise<void>;
  get: (key: string, expectedBytes: number) => Promise<Buffer>;
};

export type TagIndexStoreDeps = { sql: CoocSql; objects: TagIndexObjectStore };

export type TagIndexSnapshotManifest = {
  id: string;
  kind: TagIndexSnapshotKind;
  status: string;
  vocabVersion: string;
  specHash: string;
  payloadSha256: string;
  payloadBytes: number;
  objectKey: string;
  pinnedUntil: Date | null;
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
export class TagIndexStudyDuplicateError extends Error {}

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

export const tagIndexObjectKey = (prefix: string, kind: TagIndexSnapshotKind, sha256: string) =>
  `${prefix}/${kind}/${sha256}`;

const T = Prisma.raw('"ResourceIntentTagIndexSnapshot"');
const COLUMNS = Prisma.raw(
  `"id", "kind", "status", "vocabVersion", "specHash", "payloadSha256", "payloadBytes",
   "objectKey", "pinnedUntil", "buildStats", "createdAt", "retiredAt"`
);

async function vocabularyStatus(sql: CoocSql, vocabVersion: string): Promise<string | null> {
  const [row] = await sql.query<{ status: string }>(Prisma.sql`
    SELECT "status" FROM "ResourceIntentVocabulary" WHERE "vocabVersion" = ${vocabVersion}`);
  return row?.status ?? null;
}

async function decodeOrCorrupt(payload: Uint8Array, what: string): Promise<DecodedTagIndex> {
  try {
    return await decodeTagIndex(payload);
  } catch (e) {
    // Out of memory, not bad bytes: a later attempt can pass.
    if (isAllocationFailure(e)) throw e;
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
  kind: TagIndexSnapshotKind;
  vocabVersion: string;
  specHash: string;
  buildStats: TagBuildStats;
  pinnedUntil: Date | null;
  /** Validates the pin up front; the row's `createdAt` is the database's clock. */
  now: Date;
};

/**
 * Store a snapshot: refuse a production build whose vocabulary is not frozen (a study may name a
 * vocabulary of any status), and any payload that does not decode or whose header disagrees with
 * `meta`; upload it; then insert the manifest. A ready row of the same kind with the same bytes
 * already standing is returned with `created: false` for production, and refused for a study (its pin
 * belongs to another study).
 */
export async function putSnapshot(
  deps: TagIndexStoreDeps,
  payload: Buffer,
  meta: PutTagIndexSnapshotMeta
): Promise<{ manifest: TagIndexSnapshotManifest; created: boolean }> {
  const { sql, objects } = deps;
  assertCoocPin(meta.kind, meta.pinnedUntil, meta.now);
  if (payload.length === 0 || payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new TagIndexPayloadSizeError(
      `tag index payload is ${payload.length} bytes; allowed 1..${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  const vocabStatus = await vocabularyStatus(sql, meta.vocabVersion);
  if (vocabStatus === null)
    throw new TagIndexVocabularyMissingError(`vocabulary ${meta.vocabVersion} not found`);
  if (meta.kind === 'production' && vocabStatus !== 'frozen')
    throw new TagIndexVocabularyNotFrozenError(
      `a production build needs a frozen vocabulary; ${meta.vocabVersion} is '${vocabStatus}'`
    );
  assertHeader(await decodeOrCorrupt(payload, 'tag index payload'), meta, 'tag index payload');

  const payloadSha256 = sha256Hex(payload);
  const objectKey = tagIndexObjectKey(objects.prefix, meta.kind, payloadSha256);
  await objects.put(objectKey, payload);

  const buildStats = JSON.stringify(meta.buildStats);
  let inserted: TagIndexSnapshotManifest | undefined;
  try {
    [inserted] = await sql.query<TagIndexSnapshotManifest>(Prisma.sql`
      INSERT INTO ${T} ("kind", "vocabVersion", "specHash", "payloadSha256", "payloadBytes",
        "objectKey", "pinnedUntil", "buildStats")
      VALUES (${meta.kind}, ${meta.vocabVersion}, ${meta.specHash}, ${payloadSha256},
        ${payload.length}, ${objectKey}, ${meta.pinnedUntil}, ${buildStats}::jsonb)
      ON CONFLICT ("kind", "payloadSha256") WHERE "status" = 'ready' DO NOTHING
      RETURNING ${COLUMNS}`);
  } catch (e) {
    throw new TagIndexManifestInsertError(objectKey, e);
  }
  if (inserted) return { manifest: inserted, created: true };

  const [existing] = await sql.query<TagIndexSnapshotManifest>(Prisma.sql`
    SELECT ${COLUMNS} FROM ${T}
    WHERE "kind" = ${meta.kind} AND "payloadSha256" = ${payloadSha256} AND "status" = 'ready'`);
  if (!existing)
    throw new TagIndexManifestInsertError(
      objectKey,
      new Error('a ready row with this payload conflicted and is gone')
    );
  if (meta.kind === 'study')
    throw new TagIndexStudyDuplicateError(
      `study snapshot ${payloadSha256} already exists, pinned until ${existing.pinnedUntil?.toISOString()}`
    );
  return { manifest: existing, created: false };
}

/** The newest ready production manifest built under `specHash`. */
export async function latestReadyManifest(
  sql: CoocSql,
  specHash: string
): Promise<TagIndexSnapshotManifest | null> {
  const [row] = await sql.query<TagIndexSnapshotManifest>(Prisma.sql`
    SELECT ${COLUMNS} FROM ${T}
    WHERE "kind" = 'production' AND "specHash" = ${specHash} AND "status" = 'ready'
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT 1`);
  return row ?? null;
}

/**
 * Download and decode the snapshot a production manifest names. Refuses, each with its own error: a
 * vocabulary row that is gone or still a candidate; an object that is gone; bytes of another length
 * or sha256 than the manifest's (checked before decoding); bytes that do not decode; a header whose
 * specHash or vocabVersion is not the manifest's. Any other download failure, or running out of
 * memory while decoding, is rethrown as it is.
 */
async function loadSnapshot(
  deps: TagIndexStoreDeps,
  manifest: TagIndexSnapshotManifest
): Promise<{ manifest: TagIndexSnapshotManifest; index: TagIndex }> {
  const what = `tag index snapshot ${manifest.id}`;
  const vocabStatus = await vocabularyStatus(deps.sql, manifest.vocabVersion);
  if (vocabStatus === null)
    throw new TagIndexVocabularyMissingError(
      `${what}: vocabulary ${manifest.vocabVersion} not found`
    );
  if (vocabStatus === 'candidate')
    throw new TagIndexVocabularyNotFrozenError(
      `${what}: vocabulary ${manifest.vocabVersion} is a candidate`
    );
  const bytes = await deps.objects.get(manifest.objectKey, manifest.payloadBytes);
  if (bytes.length !== manifest.payloadBytes)
    throw new TagIndexPayloadSizeError(
      `${what}: ${bytes.length} bytes, manifest says ${manifest.payloadBytes}`
    );
  if (sha256Hex(bytes) !== manifest.payloadSha256)
    throw new TagIndexPayloadHashError(`${what}: sha256 does not match the manifest`);
  const decoded = await decodeOrCorrupt(bytes, what);
  assertHeader(decoded, manifest, what);
  return { manifest, index: decoded.index };
}

/** The newest ready production snapshot for `specHash`, verified and decoded; `null` when there is none. */
export async function loadLatestSnapshot(
  deps: TagIndexStoreDeps,
  specHash: string
): Promise<{ manifest: TagIndexSnapshotManifest; index: TagIndex } | null> {
  const manifest = await latestReadyManifest(deps.sql, specHash);
  return manifest ? loadSnapshot(deps, manifest) : null;
}
