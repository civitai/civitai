import { Prisma } from '@prisma/client';

import type { CoocSql } from '~/server/services/resource-intent-cooc/store';
import { isTagIndexObjectKey, type TagIndexObjectSweeper } from './store';

/**
 * Retention for `ResourceIntentTagIndexSnapshot` and its objects. Rows are retired, never deleted
 * (retiring is the only change the table's trigger allows, and it is one-way); an object is deleted
 * only when no ready row names its key, it lies under this store's prefix with a snapshot key's
 * shape, and it was last written longer ago than `TAG_INDEX_OBJECT_GRACE_MS`.
 */

/**
 * Ready snapshots kept under the running code's spec hash: the served one and two to fall back to.
 * Retiring the served row is how an operator rolls back (the holder serves the newest ready row), so
 * this allows two weekly rollbacks, which covers a bad build found a week late. Each costs about
 * 80 MiB of storage.
 */
export const TAG_INDEX_KEEP_READY = 3;
/**
 * Under any other spec hash, the newest ready row is kept this long after its build: a release
 * rolled back past a spec change serves it (pods only load their own spec's snapshots). The rest are
 * retired at once. Four weekly builds: a rollback is a matter of hours or days, not weeks.
 */
export const TAG_INDEX_OTHER_SPEC_KEEP_DAYS = 28;
/**
 * An object no ready row names is deleted only once it is older than this. The writer uploads, then
 * inserts its row seconds later; the build that writes runs under a 90-minute lock, so a day is far
 * past any upload whose row is still coming, and a re-put of the same bytes (which rewrites the
 * object) restarts the clock.
 */
export const TAG_INDEX_OBJECT_GRACE_MS = 24 * 3_600_000;

const DAY_MS = 86_400_000;

export type TagIndexRetentionRow = {
  id: string;
  status: string;
  specHash: string;
  objectKey: string;
  createdAt: Date;
};

/** Newest first: the order the holder picks the served row in (`latestReadyManifest`). */
function newestFirst(a: TagIndexRetentionRow, b: TagIndexRetentionRow) {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * The ready rows to retire at `now`: under `specHash`, all but the newest `TAG_INDEX_KEEP_READY`;
 * under any other spec hash, all but the newest, and that one too once it is older than
 * `TAG_INDEX_OTHER_SPEC_KEEP_DAYS`.
 */
export function selectTagIndexSnapshotsToRetire(
  rows: readonly TagIndexRetentionRow[],
  specHash: string,
  now: Date
): string[] {
  const bySpec = new Map<string, TagIndexRetentionRow[]>();
  for (const r of rows) {
    if (r.status !== 'ready') continue;
    const group = bySpec.get(r.specHash) ?? [];
    group.push(r);
    bySpec.set(r.specHash, group);
  }
  const out: string[] = [];
  for (const [spec, group] of bySpec) {
    group.sort(newestFirst);
    group.forEach((r, i) => {
      const keep =
        spec === specHash
          ? i < TAG_INDEX_KEEP_READY
          : i === 0 &&
            now.getTime() - r.createdAt.getTime() <= TAG_INDEX_OTHER_SPEC_KEEP_DAYS * DAY_MS;
      if (!keep) out.push(r.id);
    });
  }
  return out;
}

export type TagIndexRetentionResult = {
  /** Rows retired by this run. */
  retired: string[];
  /** Objects deleted: named only by retired rows, and named by no row at all (an orphaned upload). */
  deleted: { retired: number; orphaned: number; bytes: number };
  /** Objects kept although no ready row names them, because they are inside the grace period. */
  keptRecent: number;
  /** Objects under the prefix whose key is not a snapshot key; never touched. */
  foreign: number;
};

/**
 * Retire what `selectTagIndexSnapshotsToRetire` picks, then delete each object under the store's
 * prefix that no ready row names and that is older than `TAG_INDEX_OBJECT_GRACE_MS`. The ready keys
 * are read after the listing, so a row inserted while the listing ran protects its object. What
 * keeps a concurrent put safe is the grace period, not the job lock (which a long build can outlast,
 * and which is not taken outside production): a fresh upload is never old enough to delete. The one
 * unprotected case is a put of bytes identical to an old unnamed object landing between the ready
 * read and the delete; the weekly job is the only writer and runs this after its own put.
 */
export async function applyTagIndexRetention(
  deps: { sql: CoocSql; objects: TagIndexObjectSweeper },
  opts: { now: Date; specHash: string }
): Promise<TagIndexRetentionResult> {
  const { sql, objects } = deps;
  const T = Prisma.raw('"ResourceIntentTagIndexSnapshot"');
  const rows = await sql.query<TagIndexRetentionRow>(Prisma.sql`
    SELECT "id", "status", "specHash", "objectKey", "createdAt" FROM ${T}`);
  const retired = selectTagIndexSnapshotsToRetire(rows, opts.specHash, opts.now);
  if (retired.length)
    await sql.execute(Prisma.sql`
      UPDATE ${T} SET "status" = 'retired'
      WHERE "id" = ANY(${retired}::text[]) AND "status" = 'ready'`);

  const listed = [];
  for await (const o of objects.list()) listed.push(o);
  const ready = new Set(
    (
      await sql.query<{ objectKey: string }>(Prisma.sql`
        SELECT DISTINCT "objectKey" FROM ${T} WHERE "status" = 'ready'`)
    ).map((r) => r.objectKey)
  );
  const named = new Set(rows.map((r) => r.objectKey));

  const result: TagIndexRetentionResult = {
    retired,
    deleted: { retired: 0, orphaned: 0, bytes: 0 },
    keptRecent: 0,
    foreign: 0,
  };
  for (const o of listed) {
    if (!isTagIndexObjectKey(objects.prefix, o.key)) {
      result.foreign++;
      continue;
    }
    if (ready.has(o.key)) continue;
    if (opts.now.getTime() - o.lastModified.getTime() < TAG_INDEX_OBJECT_GRACE_MS) {
      result.keptRecent++;
      continue;
    }
    await objects.delete(o.key);
    if (named.has(o.key)) result.deleted.retired++;
    else result.deleted.orphaned++;
    result.deleted.bytes += o.bytes;
  }
  return result;
}
