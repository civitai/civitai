import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import { COOC_MAX_PAYLOAD_BYTES, deserializeCoocCounts, type CoocCounts } from './build';

/**
 * `ResourceIntentCoocSnapshot` storage: the build lifecycle (begin → ready | failed | duplicate),
 * verified load, the served snapshot, retention and release.
 *
 * Raw SQL so the tests run the migration's real CHECKs and partial unique index.
 *
 * The request path reads this on the POOL_MERGE arm: `holder.ts` calls `latestReadySnapshotId` and
 * `loadCoocSnapshot` (production, polled) and `loadCoocSnapshot` (study, by hash). When no snapshot
 * can be served, the contract is the operator's, implemented by the service: "Return BASE's top
 * 50, still fully gated, with `coocFallback: true`, a 60 s cache and a logged reason. Users get a
 * usable list. In study mode the request fails closed regardless."
 */

export type CoocSql = {
  query: <T>(sql: Prisma.Sql) => Promise<T[]>;
  execute: (sql: Prisma.Sql) => Promise<number>;
};

export function coocSqlOf(db: {
  $queryRaw: <T>(sql: Prisma.Sql) => Promise<T>;
  $executeRaw: (sql: Prisma.Sql) => Promise<number>;
}): CoocSql {
  return {
    query: <T>(sql: Prisma.Sql) => db.$queryRaw<T[]>(sql),
    execute: (sql) => db.$executeRaw(sql),
  };
}

export type CoocSnapshotKind = 'production' | 'study';
export const COOC_SNAPSHOT_KINDS: readonly CoocSnapshotKind[] = ['production', 'study'];

export const DAY_MS = 86_400_000;
/**
 * A study pin may run at most this long after the build. With the daily sweep and a ~26 h
 * staleness alert on the retention heartbeat (an alert rule that must be provisioned outside this
 * repo), a missed sweep alerts before any study row reaches 60 days.
 */
export const COOC_MAX_PIN_DAYS = 58;
/** A study row still present this long after its build fails the sweep. */
export const COOC_STUDY_HARD_LIMIT_DAYS = 60;
/** Ready production snapshots older than this are deleted, except the served one. */
export const COOC_PRODUCTION_RETENTION_DAYS = 28;
/** Rows that never became ready are deleted after this. */
export const COOC_NOT_READY_RETENTION_DAYS = 7;

export type CoocSnapshotMeta = {
  id: string;
  kind: CoocSnapshotKind;
  status: string;
  contentHash: string | null;
  specHash: string;
  trainStart: Date;
  trainEnd: Date;
  seed: number;
  pinnedUntil: Date | null;
  builtAt: Date;
  trainCreatedAtMin: Date | null;
  trainCreatedAtMax: Date | null;
  idsTried: number | null;
  trainRows: number | null;
  vocab: number | null;
  models: number | null;
  keptPairs: number | null;
};

/**
 * The stored snapshot itself cannot be served: reading the same row again returns the same bytes
 * and fails the same way, so only a different snapshot can fix it.
 */
export class CoocSnapshotUnservableError extends Error {}
export class CoocSnapshotHashMismatchError extends CoocSnapshotUnservableError {}
export class CoocSnapshotExpiredError extends Error {}
export class CoocSnapshotKindMismatchError extends CoocSnapshotUnservableError {}
/** The payload's hash matched but it did not decode: too large, unknown format, or invalid counts. */
export class CoocSnapshotCorruptError extends CoocSnapshotUnservableError {}
export class CoocStudyDuplicateError extends Error {}

/**
 * A snapshot's identity: sha256 of its kind, a NUL and its payload. Binding the kind means a study
 * build and a production build of identical data are distinct snapshots, so releasing one never
 * touches the other.
 */
export function coocContentHash(kind: CoocSnapshotKind, payload: Uint8Array): string {
  return createHash('sha256').update(kind).update('\0').update(payload).digest('hex');
}

/**
 * The pin rules, in one place for the pipeline and the store (the migration's CHECK holds the same
 * against the database's `builtAt`): a study snapshot is always pinned, ending after `builtAt` and
 * at most `COOC_MAX_PIN_DAYS` later; a production snapshot is never pinned.
 */
export function assertCoocPin(kind: CoocSnapshotKind, pinnedUntil: Date | null, builtAt: Date) {
  if (!COOC_SNAPSHOT_KINDS.includes(kind)) throw new Error(`unknown snapshot kind '${kind}'`);
  if (kind === 'production') {
    if (pinnedUntil !== null) throw new Error('a production snapshot cannot be pinned');
    return;
  }
  if (pinnedUntil === null) throw new Error('a study snapshot requires a pin (--pin-until)');
  if (pinnedUntil.getTime() <= builtAt.getTime())
    throw new Error('the pin must end after the build');
  if (pinnedUntil.getTime() > builtAt.getTime() + COOC_MAX_PIN_DAYS * DAY_MS)
    throw new Error(`a pin may run at most ${COOC_MAX_PIN_DAYS} days from the build`);
}

const T = Prisma.raw('"ResourceIntentCoocSnapshot"');

/**
 * Record a build as started. `now` only validates the pin up front; the row's `builtAt` is the
 * database's clock, and the CHECK re-validates the pin against it.
 */
export async function beginCoocBuild(
  sql: CoocSql,
  b: {
    kind: CoocSnapshotKind;
    specHash: string;
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
    INSERT INTO ${T} ("kind", "specHash", "trainStart", "trainEnd", "seed", "pinnedUntil")
    VALUES (${b.kind}, ${b.specHash}, ${b.trainStart}, ${b.trainEnd}, ${b.seed}, ${b.pinnedUntil})
    RETURNING "id", "builtAt"`);
  return row;
}

export type CoocBuildResult = {
  payload: Buffer;
  trainImageIds: Buffer;
  trainCreatedAtMin: Date;
  trainCreatedAtMax: Date;
  idsTried: number;
  trainRows: number;
  vocab: number;
  models: number;
  keptPairs: number;
};

async function readyRowWithHash(sql: CoocSql, contentHash: string) {
  const rows = await sql.query<{ id: string }>(Prisma.sql`
    SELECT "id" FROM ${T} WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
  return rows[0]?.id ?? null;
}

/**
 * Mark a building row ready with its payload. If a ready snapshot with the same content already
 * exists (a same-day re-run), this row becomes 'duplicate' and the existing one stands. For a
 * study that also throws: the existing row carries ANOTHER study's pin, so silently sharing it
 * would let that study's pin or release delete this one's snapshot.
 */
export async function completeCoocBuild(
  sql: CoocSql,
  id: string,
  r: CoocBuildResult
): Promise<{ contentHash: string; created: boolean }> {
  if (r.payload.length > COOC_MAX_PAYLOAD_BYTES)
    throw new Error(`cooc payload ${r.payload.length} bytes exceeds ${COOC_MAX_PAYLOAD_BYTES}`);
  const [row] = await sql.query<{ kind: CoocSnapshotKind; status: string }>(Prisma.sql`
    SELECT "kind", "status" FROM ${T} WHERE "id" = ${id}`);
  if (!row) throw new Error(`cooc build ${id} not found`);
  if (row.status !== 'building') throw new Error(`cooc build ${id} is '${row.status}'`);
  const contentHash = coocContentHash(row.kind, r.payload);
  const markDuplicate = async () => {
    await sql.execute(Prisma.sql`
      UPDATE ${T} SET "status" = 'duplicate' WHERE "id" = ${id} AND "status" = 'building'`);
    if (row.kind === 'study') {
      const [existing] = await sql.query<{ pinnedUntil: Date | null }>(Prisma.sql`
        SELECT "pinnedUntil" FROM ${T} WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
      throw new CoocStudyDuplicateError(
        `study snapshot ${contentHash} already exists, pinned until ${existing?.pinnedUntil?.toISOString()}; use a different --seed or --train-end`
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
    if (n !== 1) throw new Error(`cooc build ${id} was not 'building' when completed`);
  } catch (e) {
    // A concurrent identical build won the partial unique index between the check and the write.
    if (await readyRowWithHash(sql, contentHash)) return markDuplicate();
    throw e;
  }
  return { contentHash, created: true };
}

export async function failCoocBuild(sql: CoocSql, id: string): Promise<void> {
  await sql.execute(Prisma.sql`
    UPDATE ${T} SET "status" = 'failed' WHERE "id" = ${id} AND "status" = 'building'`);
}

const META_COLUMNS = Prisma.raw(
  `"id", "kind", "status", "contentHash", "specHash", "trainStart", "trainEnd", "seed",
   "pinnedUntil", "builtAt", "trainCreatedAtMin", "trainCreatedAtMax", "idsTried", "trainRows",
   "vocab", "models", "keptPairs"`
);

/**
 * Load a ready snapshot by content hash, refusing bytes whose hash does not match, a row of another
 * kind than the caller asked for, a payload that does not decode (`CoocSnapshotCorruptError`), and
 * a study snapshot whose pin has passed (even if retention has not yet run).
 */
export async function loadCoocSnapshot(
  sql: CoocSql,
  contentHash: string,
  opts: { kind: CoocSnapshotKind; now: Date }
): Promise<{ meta: CoocSnapshotMeta; counts: CoocCounts }> {
  const now = opts.now;
  const [row] = await sql.query<CoocSnapshotMeta & { payload: Uint8Array }>(Prisma.sql`
    SELECT ${META_COLUMNS}, "payload" FROM ${T}
    WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
  if (!row) throw new Error(`cooc snapshot ${contentHash} not found`);
  const { payload, ...meta } = row;
  if (
    !COOC_SNAPSHOT_KINDS.includes(meta.kind) ||
    coocContentHash(meta.kind, payload) !== contentHash
  )
    throw new CoocSnapshotHashMismatchError(`cooc snapshot ${contentHash}: content hash mismatch`);
  if (meta.kind !== opts.kind)
    throw new CoocSnapshotKindMismatchError(
      `cooc snapshot ${contentHash} is '${meta.kind}', expected '${opts.kind}'`
    );
  if (meta.kind === 'study' && (!meta.pinnedUntil || meta.pinnedUntil.getTime() <= now.getTime()))
    throw new CoocSnapshotExpiredError(`cooc study snapshot ${contentHash}: pin has passed`);
  let counts: CoocCounts;
  try {
    counts = await deserializeCoocCounts(payload);
  } catch (e) {
    throw new CoocSnapshotCorruptError(
      `cooc snapshot ${contentHash}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return { meta, counts };
}

/**
 * The served snapshot's content hash: the newest READY PRODUCTION build by training window end,
 * then build time. `selectCoocSnapshotsToDelete` protects exactly this row.
 */
export async function latestReadySnapshotId(sql: CoocSql): Promise<string | null> {
  const rows = await sql.query<{ contentHash: string }>(Prisma.sql`
    SELECT "contentHash" FROM ${T}
    WHERE "kind" = 'production' AND "status" = 'ready'
    ORDER BY "trainEnd" DESC, "builtAt" DESC, "id" DESC
    LIMIT 1`);
  return rows[0]?.contentHash ?? null;
}

type RetentionRow = Pick<
  CoocSnapshotMeta,
  'id' | 'kind' | 'status' | 'trainEnd' | 'builtAt' | 'pinnedUntil'
>;

/** `latestReadySnapshotId`'s ORDER BY as a comparator (newest first). */
function servedOrder(a: RetentionRow, b: RetentionRow) {
  return (
    b.trainEnd.getTime() - a.trainEnd.getTime() ||
    b.builtAt.getTime() - a.builtAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/**
 * Which rows retention deletes at `now`:
 * - the served snapshot (the row `latestReadySnapshotId` reads) never;
 * - other ready production snapshots once older than `COOC_PRODUCTION_RETENTION_DAYS`;
 * - study rows, of any status, once their pin has passed (or with no pin, or
 *   `COOC_MAX_PIN_DAYS` after the build);
 * - other rows that are not ready ('building', 'failed', 'duplicate'), once older than
 *   `COOC_NOT_READY_RETENTION_DAYS`.
 */
export function selectCoocSnapshotsToDelete(rows: readonly RetentionRow[], now: Date): string[] {
  const t = now.getTime();
  const served = rows
    .filter((r) => r.kind === 'production' && r.status === 'ready')
    .sort(servedOrder)[0];
  const out: string[] = [];
  for (const r of rows) {
    if (r.id === served?.id) continue;
    const age = t - r.builtAt.getTime();
    const studyExpired =
      r.kind === 'study' &&
      (!r.pinnedUntil || r.pinnedUntil.getTime() <= t || age >= COOC_MAX_PIN_DAYS * DAY_MS);
    let drop: boolean;
    if (studyExpired) drop = true;
    else if (r.status !== 'ready') drop = age > COOC_NOT_READY_RETENTION_DAYS * DAY_MS;
    else if (r.kind === 'study') drop = false;
    else drop = age > COOC_PRODUCTION_RETENTION_DAYS * DAY_MS;
    if (drop) out.push(r.id);
  }
  return out;
}

const isUndefinedTable = (e: unknown) => {
  const x = e as { code?: string; meta?: { code?: string } } | null;
  return x?.code === '42P01' || x?.meta?.code === '42P01';
};

export class CoocRetentionOverdueError extends Error {}

/**
 * Runs retention, then re-reads the table with an independent SQL predicate: any study row still
 * past its pin or 60 days after its build fails the sweep (so it writes no heartbeat). A missing
 * table (migration not applied here yet) is not an error.
 */
export async function applyCoocRetention(
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
    throw new CoocRetentionOverdueError(
      `${overdue.length} study snapshot row(s) past their pin or ${COOC_STUDY_HARD_LIMIT_DAYS} days survived the sweep`
    );
  return { deleted };
}

/**
 * Delete a ready study snapshot now. Refuses a production snapshot. `dryRun` reports the row and
 * deletes nothing.
 */
export async function releaseCoocSnapshot(
  sql: CoocSql,
  contentHash: string,
  opts: { dryRun: boolean }
): Promise<{ id: string; deleted: boolean }> {
  const [row] = await sql.query<{ id: string; kind: string }>(Prisma.sql`
    SELECT "id", "kind" FROM ${T} WHERE "contentHash" = ${contentHash} AND "status" = 'ready'`);
  if (!row) throw new Error(`cooc snapshot ${contentHash} not found`);
  if (row.kind !== 'study')
    throw new Error(`cooc snapshot ${contentHash} is '${row.kind}'; only study snapshots release`);
  if (opts.dryRun) return { id: row.id, deleted: false };
  await sql.execute(Prisma.sql`DELETE FROM ${T} WHERE "id" = ${row.id} AND "kind" = 'study'`);
  return { id: row.id, deleted: true };
}

/**
 * A study evaluated on rows from `windowStart` on may only use a snapshot trained strictly before
 * them, with the spec's gap: every training image before `trainEnd`, and `trainEnd` at least
 * `gapDays` before the window.
 */
export function assertSnapshotPrecedesWindow(
  meta: Pick<CoocSnapshotMeta, 'trainEnd' | 'trainCreatedAtMax'>,
  windowStart: Date,
  gapDays: number
) {
  if (!meta.trainCreatedAtMax || meta.trainCreatedAtMax.getTime() >= meta.trainEnd.getTime())
    throw new Error('snapshot holds a training image at or after its trainEnd');
  if (meta.trainEnd.getTime() > windowStart.getTime() - gapDays * DAY_MS)
    throw new Error(
      `snapshot trainEnd ${meta.trainEnd.toISOString()} is not ${gapDays} day(s) before the window`
    );
}
