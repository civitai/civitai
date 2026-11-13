import { Prisma } from '@prisma/client';

import type { CoocSql } from '~/server/services/resource-intent-cooc/store';
import { isTagIndexObjectKey, type TagIndexObjectSweeper } from './store';

/**
 * Retention for `ResourceIntentTagIndexSnapshot` and its objects. Rows are retired, never deleted
 * (retiring is the only change the table's trigger allows, and it is one-way). An object is deleted
 * only when THIS database's retired rows name its key and none of its ready rows does, and the key is
 * a snapshot key under this store's prefix. Nothing is listed, so nothing outside this database's
 * own retired rows is touched. That does NOT make a shared bucket safe: the payload depends only on
 * the input data and the build day, so two environments can produce the same key, and one's
 * retention could delete an object the other serves; each environment needs its own bucket (see
 * the store). The cost of not listing is one leak: an upload whose row insert failed (a build killed
 * between the two) is named by no row and stays. It is one object, and a later put of the same bytes
 * reuses its key.
 */

/**
 * Ready snapshots kept under the running code's spec hash: the served one and two to fall back to.
 * Retiring the served row is how an operator rolls back (the holder serves the newest ready row), so
 * this allows two weekly rollbacks, which covers a bad build found a week late. Each costs about
 * 146 MiB of storage at full coverage (October 2026).
 */
export const TAG_INDEX_KEEP_READY = 3;
/**
 * Under any other spec hash, the newest ready row is kept this long after its build: a release
 * rolled back past a spec change serves it (pods only load their own spec's snapshots). The rest are
 * retired at once. Four weekly builds: a rollback is a matter of hours or days, not weeks.
 */
export const TAG_INDEX_OTHER_SPEC_KEEP_DAYS = 28;
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
  /**
   * Objects deleted: those retired rows name and no ready row does. A key deleted by an earlier run
   * is deleted again (a no-op on a missing key), so this counts keys, not bytes freed.
   */
  deleted: number;
  /** Keys retired rows name that are not snapshot keys under this store's prefix; never touched. */
  foreign: number;
};

/**
 * Retire what `selectTagIndexSnapshotsToRetire` picks, then delete each object a retired row names
 * that no ready row names. The ready rows are read after retiring, so a row inserted meanwhile (a
 * put of identical bytes, which reuses the key) protects its object; the weekly job is the only
 * writer and runs this after its own put.
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

  const keys = await sql.query<{ objectKey: string }>(Prisma.sql`
    SELECT DISTINCT r."objectKey" FROM ${T} r
    WHERE r."status" = 'retired'
      AND NOT EXISTS (
        SELECT 1 FROM ${T} k WHERE k."status" = 'ready' AND k."objectKey" = r."objectKey")`);
  const result: TagIndexRetentionResult = { retired, deleted: 0, foreign: 0 };
  // One key's failure must not stop the rest (a key that always fails would otherwise end
  // retention for good): every key is tried, then any failure fails the sweep, so its heartbeat
  // goes stale and the job reports the error.
  const failures: string[] = [];
  for (const { objectKey } of keys) {
    if (!isTagIndexObjectKey(objects.prefix, objectKey)) {
      result.foreign++;
      continue;
    }
    try {
      await objects.delete(objectKey);
      result.deleted++;
    } catch (e) {
      failures.push(`${objectKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length)
    throw new Error(
      `tag index retention: ${failures.length} of ${keys.length} deletes failed (${
        result.deleted
      } deleted, ${result.retired.length} retired): ${failures.join('; ')}`
    );
  return result;
}
