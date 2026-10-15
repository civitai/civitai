import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import { COOC_MAX_PAYLOAD_BYTES } from '~/server/services/resource-intent-cooc/build';
import {
  assertCoocPin,
  COOC_SNAPSHOT_KINDS,
  COOC_STUDY_HARD_LIMIT_DAYS,
  DAY_MS,
  isAllocationFailure,
  isUndefinedTable,
  selectCoocSnapshotsToDelete,
  type CoocBuildResult,
  type CoocSnapshotKind,
  type CoocSnapshotMeta,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';

/**
 * `ResourceIntentTagIndexSnapshot` storage: the co-occurrence store's lifecycle (begin → ready |
 * failed | duplicate, verified load, the served snapshot, retention, release) on the content-tag
 * index's own table. The pin limits and which rows retention deletes are the co-occurrence store's
 * own functions, shared rather than copied.
 */

export const TAG_INDEX_MAX_PAYLOAD_BYTES = COOC_MAX_PAYLOAD_BYTES;

export type TagIndexSnapshotMeta = CoocSnapshotMeta & { vocabVersion: string };
export type TagIndexBuildResult = CoocBuildResult;

export class TagIndexSnapshotUnservableError extends Error {}
export class TagIndexSnapshotHashMismatchError extends TagIndexSnapshotUnservableError {}
export class TagIndexSnapshotKindMismatchError extends TagIndexSnapshotUnservableError {}
/** The payload's hash matched but the caller's decoder rejected it. */
export class TagIndexSnapshotCorruptError extends TagIndexSnapshotUnservableError {}
export class TagIndexSnapshotExpiredError extends Error {}
export class TagIndexStudyDuplicateError extends Error {}
export class TagIndexRetentionOverdueError extends Error {}

const T = Prisma.raw('"ResourceIntentTagIndexSnapshot"');

/**
 * A snapshot's identity: sha256 of its kind, its vocabulary version and its payload, NUL-separated.
 * The vocabulary is bound in so that a rebuild under a re-frozen vocabulary is a new snapshot even
 * when the index bytes come out the same.
 */
export function tagIndexContentHash(
  kind: CoocSnapshotKind,
  vocabVersion: string,
  payload: Uint8Array
): string {
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(vocabVersion)
    .update('\0')
    .update(payload)
    .digest('hex');
}

/**
 * Record a build as started. `now` only validates the pin up front; the row's `builtAt` is the
 * database's clock, and the CHECK re-validates the pin against it. A production build must name a
 * frozen vocabulary, checked when the build starts; a study may use one of any status.
 */
export async function beginTagIndexBuild(
  sql: CoocSql,
  b: {
    kind: CoocSnapshotKind;
    specHash: string;
    vocabVersion: string;
    trainStart: Date;
    trainEnd: Date;
    seed: number;
    pinnedUntil: Date | null;
    now: Date;
  }
): Promise<{ id: string; builtAt: Date }> {
  if ('builtAt' in b) throw new Error('builtAt is set by the database, never by the writer');
  assertCoocPin(b.kind, b.pinnedUntil, b.now);
  const [row] = await sql.query<{ id: string; builtAt: Date }>(Prisma.sql`
    INSERT INTO ${T} ("kind", "specHash", "vocabVersion", "trainStart", "trainEnd", "seed", "pinnedUntil")
    SELECT ${b.kind}, ${b.specHash}, v."vocabVersion", ${b.trainStart}, ${b.trainEnd}, ${b.seed},
      ${b.pinnedUntil}
    FROM "ResourceIntentVocabulary" v
    WHERE v."vocabVersion" = ${b.vocabVersion} AND (${b.kind} = 'study' OR v."status" = 'frozen')
    RETURNING "id", "builtAt"`);
  if (!row)
    throw new Error(
      `vocabulary ${b.vocabVersion} does not exist${
        b.kind === 'production' ? ' or is not frozen' : ''
      }`
    );
  return row;
}

async function readyRowWithHash(sql: CoocSql, contentHash: string) {
  const rows = await sql.query<{ id: string }>(Prisma.sql`
    SELECT "id" FROM ${T} WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
  return rows[0]?.id ?? null;
}

/**
 * Mark a building row ready with its payload. If a ready snapshot with the same content already
 * exists, this row becomes 'duplicate' and the existing one stands; for a study that also throws,
 * because the existing row carries another study's pin.
 */
export async function completeTagIndexBuild(
  sql: CoocSql,
  id: string,
  r: TagIndexBuildResult
): Promise<{ contentHash: string; created: boolean }> {
  if (r.payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new Error(
      `tag index payload ${r.payload.length} bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  const [row] = await sql.query<{ kind: CoocSnapshotKind; status: string; vocabVersion: string }>(
    Prisma.sql`SELECT "kind", "status", "vocabVersion" FROM ${T} WHERE "id" = ${id}`
  );
  if (!row) throw new Error(`tag index build ${id} not found`);
  if (row.status !== 'building') throw new Error(`tag index build ${id} is '${row.status}'`);
  const contentHash = tagIndexContentHash(row.kind, row.vocabVersion, r.payload);
  const markDuplicate = async () => {
    await sql.execute(Prisma.sql`
      UPDATE ${T} SET "status" = 'duplicate' WHERE "id" = ${id} AND "status" = 'building'`);
    if (row.kind === 'study') {
      const [existing] = await sql.query<{ pinnedUntil: Date | null }>(Prisma.sql`
        SELECT "pinnedUntil" FROM ${T} WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
      throw new TagIndexStudyDuplicateError(
        `study tag index ${contentHash} already exists, pinned until ${existing?.pinnedUntil?.toISOString()}`
      );
    }
    return { contentHash, created: false };
  };
  if (await readyRowWithHash(sql, contentHash)) return markDuplicate();
  try {
    const n = await sql.execute(Prisma.sql`
      UPDATE ${T} SET "status" = 'ready', "contentHash" = ${contentHash}, "payload" = ${r.payload},
        "trainImageIds" = ${r.trainImageIds}, "trainCreatedAtMin" = ${r.trainCreatedAtMin},
        "trainCreatedAtMax" = ${r.trainCreatedAtMax}, "idsTried" = ${r.idsTried},
        "trainRows" = ${r.trainRows}, "vocab" = ${r.vocab}, "models" = ${r.models},
        "keptPairs" = ${r.keptPairs}
      WHERE "id" = ${id} AND "status" = 'building'`);
    if (n !== 1) throw new Error(`tag index build ${id} was not 'building' when completed`);
  } catch (e) {
    // A concurrent identical build won the partial unique index between the check and the write.
    if (await readyRowWithHash(sql, contentHash)) return markDuplicate();
    throw e;
  }
  return { contentHash, created: true };
}

export async function failTagIndexBuild(sql: CoocSql, id: string): Promise<void> {
  await sql.execute(Prisma.sql`
    UPDATE ${T} SET "status" = 'failed' WHERE "id" = ${id} AND "status" = 'building'`);
}

const META_COLUMNS = Prisma.raw(
  `"id", "kind", "status", "contentHash", "specHash", "vocabVersion", "trainStart", "trainEnd",
   "seed", "pinnedUntil", "builtAt", "trainCreatedAtMin", "trainCreatedAtMax", "idsTried",
   "trainRows", "vocab", "models", "keptPairs"`
);

/**
 * Load a ready snapshot by content hash and decode its payload with `decode`, refusing bytes whose
 * hash does not match, a row of another kind than the caller asked for, a payload `decode` rejects
 * (`TagIndexSnapshotCorruptError`; the decoder owns the size ceiling, as the cooc decoder does), and
 * a study snapshot whose pin has passed. An allocation failure while decoding is rethrown as is:
 * a later read can pass.
 */
export async function loadTagIndexSnapshot<P>(
  sql: CoocSql,
  contentHash: string,
  opts: { kind: CoocSnapshotKind; now: Date; decode: (payload: Uint8Array) => Promise<P> | P }
): Promise<{ meta: TagIndexSnapshotMeta; payload: P }> {
  const [row] = await sql.query<TagIndexSnapshotMeta & { payload: Uint8Array }>(Prisma.sql`
    SELECT ${META_COLUMNS}, "payload" FROM ${T}
    WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
  if (!row) throw new Error(`tag index snapshot ${contentHash} not found`);
  const { payload, ...meta } = row;
  if (
    !COOC_SNAPSHOT_KINDS.includes(meta.kind) ||
    tagIndexContentHash(meta.kind, meta.vocabVersion, payload) !== contentHash
  )
    throw new TagIndexSnapshotHashMismatchError(
      `tag index snapshot ${contentHash}: content hash mismatch`
    );
  if (meta.kind !== opts.kind)
    throw new TagIndexSnapshotKindMismatchError(
      `tag index snapshot ${contentHash} is '${meta.kind}', expected '${opts.kind}'`
    );
  if (
    meta.kind === 'study' &&
    (!meta.pinnedUntil || meta.pinnedUntil.getTime() <= opts.now.getTime())
  )
    throw new TagIndexSnapshotExpiredError(`study tag index ${contentHash}: pin has passed`);
  try {
    return { meta, payload: await opts.decode(payload) };
  } catch (e) {
    if (isAllocationFailure(e)) throw e;
    throw new TagIndexSnapshotCorruptError(
      `tag index snapshot ${contentHash}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * The served snapshot's content hash: the newest READY PRODUCTION build by training window end,
 * then build time. Retention protects exactly this row.
 */
export async function latestReadyTagIndexSnapshotId(sql: CoocSql): Promise<string | null> {
  const rows = await sql.query<{ contentHash: string }>(Prisma.sql`
    SELECT "contentHash" FROM ${T}
    WHERE "kind" = 'production' AND "status" = 'ready'
    ORDER BY "trainEnd" DESC, "builtAt" DESC, "id" DESC
    LIMIT 1`);
  return rows[0]?.contentHash ?? null;
}

type RetentionRow = Parameters<typeof selectCoocSnapshotsToDelete>[0][number];

/**
 * Runs retention (`selectCoocSnapshotsToDelete`'s rules), then re-reads the table with an
 * independent SQL predicate: any study row still past its pin or `COOC_STUDY_HARD_LIMIT_DAYS` after
 * its build fails the sweep (the second disjunct is a backstop the 58-day pin CHECK keeps
 * unreachable). A missing table (migration not applied here yet) is not an error.
 */
export async function applyTagIndexRetention(
  sql: CoocSql,
  now: Date
): Promise<{ deleted: string[]; tableMissing?: true }> {
  let rows: RetentionRow[];
  try {
    rows = await sql.query<RetentionRow>(Prisma.sql`
      SELECT "id", "kind", "status", "trainEnd", "builtAt", "pinnedUntil" FROM ${T}`);
  } catch (e) {
    if (isUndefinedTable(e)) return { deleted: [], tableMissing: true };
    throw e;
  }
  const deleted = selectCoocSnapshotsToDelete(rows, now);
  if (deleted.length)
    await sql.execute(Prisma.sql`DELETE FROM ${T} WHERE "id" = ANY(${deleted}::text[])`);
  const hardLimit = new Date(now.getTime() - COOC_STUDY_HARD_LIMIT_DAYS * DAY_MS);
  const overdue = await sql.query<{ id: string }>(Prisma.sql`
    SELECT "id" FROM ${T}
    WHERE "kind" = 'study'
      AND ("pinnedUntil" IS NULL OR "pinnedUntil" <= ${now} OR "builtAt" <= ${hardLimit})`);
  if (overdue.length)
    throw new TagIndexRetentionOverdueError(
      `${overdue.length} study tag index row(s) past their pin or ${COOC_STUDY_HARD_LIMIT_DAYS} days survived the sweep`
    );
  return { deleted };
}

/** Delete a ready study snapshot now. Refuses a production snapshot. `dryRun` deletes nothing. */
export async function releaseTagIndexSnapshot(
  sql: CoocSql,
  contentHash: string,
  opts: { dryRun: boolean }
): Promise<{ id: string; deleted: boolean }> {
  const [row] = await sql.query<{ id: string; kind: string }>(Prisma.sql`
    SELECT "id", "kind" FROM ${T} WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
  if (!row) throw new Error(`tag index snapshot ${contentHash} not found`);
  if (row.kind !== 'study')
    throw new Error(
      `tag index snapshot ${contentHash} is '${row.kind}'; only study snapshots release`
    );
  if (opts.dryRun) return { id: row.id, deleted: false };
  await sql.execute(Prisma.sql`DELETE FROM ${T} WHERE "id" = ${row.id} AND "kind" = 'study'`);
  return { id: row.id, deleted: true };
}
