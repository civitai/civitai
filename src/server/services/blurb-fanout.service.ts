import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getBlurbFanoutAdapter,
  getSupportedBlurbEntityTypes,
} from '~/server/services/blurb-fanout.adapters';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { replaceBlurbSpans, unwrapBlurbSpans } from '~/server/utils/blurb-html';

type Ref = { blurbId: number; entityType: string; entityId: number; materializedHash: string };
type Blurb = { id: number; content: string; contentHash: string; deletedAt: Date | null };
type StaleRow = Ref & Blurb;

export type FanoutOutcome = 'rewritten' | 'skipped' | 'gone' | 'unsupported' | 'conflict';

/**
 * One entity, every stale reference it has, one load and one save.
 *
 * 🔴 Per reference instead and the entity loses an edit. Two stale rows for one article share a
 * `materializedAt` — `reconcileBlurbReferences` stamps them from a single `now` — so they sort
 * adjacently under `ORDER BY materializedAt ASC` and land in the same batch. Each would load the
 * same html, splice in only its OWN blurb, and save the whole body: last write wins, the other
 * edit is discarded, and both rows are stamped current so it is never retried.
 */
export async function processBlurbEntity(rows: StaleRow[]): Promise<FanoutOutcome> {
  const [first] = rows;
  const adapter = getBlurbFanoutAdapter(first.entityType);
  if (!adapter) return 'unsupported';

  const loaded = await adapter.load(first.entityId);
  if (!loaded) {
    // A reference can outlive its entity — entityType/entityId is a loose pair, not a
    // foreign key. Dropping it stops one deleted article being re-selected on every pass
    // forever.
    await dropReferences(rows);
    return 'gone';
  }

  const replacements = new Map<number, string>();
  const removals = new Set<number>();
  for (const row of rows) {
    if (row.deletedAt) removals.add(row.blurbId);
    else replacements.set(row.blurbId, row.content);
  }

  // Replace before unwrap: both rescan the html they are handed, and a deleted blurb's span has
  // to still be there for the unwrap to find it.
  let next = replaceBlurbSpans(loaded.html, replacements);
  if (removals.size) next = unwrapBlurbSpans(next, removals);

  const rewritten = next !== loaded.html;
  if (rewritten) {
    const applied = await adapter.save({
      entityId: first.entityId,
      userId: loaded.userId,
      html: next,
      expectedHtml: loaded.html,
    });
    // Someone saved the entity between our load and our save. Record nothing: the references stay
    // pending, and the next pass re-reads the body they actually wrote and splices into that.
    // Recording here is what made the clobbered edit permanent — the rows were stamped current, so
    // nothing ever looked at that entity again.
    if (!applied) return 'conflict';
  }

  const deleted = rows.filter((row) => row.deletedAt);
  if (deleted.length) await dropReferences(deleted);
  const live = rows.filter((row) => !row.deletedAt);
  if (live.length) await recordReferences(live);

  return rewritten ? 'rewritten' : 'skipped';
}

function dropReferences(rows: Ref[]) {
  const [first] = rows;
  return dbWrite.blurbReference.deleteMany({
    where: {
      entityType: first.entityType,
      entityId: first.entityId,
      blurbId: { in: rows.map((r) => r.blurbId) },
    },
  });
}

// Grouped by hash rather than one update per row: rows in a batch share an entity, so this is
// `updateMany` per DISTINCT contentHash — normally one statement, where the loop it replaced was
// up to `BATCH_LIMIT` sequential round trips to the primary on every pass. `dropReferences`
// beside it already batched; this did not.
function recordReferences(rows: StaleRow[]) {
  const [first] = rows;
  const now = new Date();
  const byHash = new Map<string, number[]>();
  for (const row of rows) {
    const ids = byHash.get(row.contentHash);
    if (ids) ids.push(row.blurbId);
    else byHash.set(row.contentHash, [row.blurbId]);
  }

  return Promise.all(
    [...byHash].map(([contentHash, blurbIds]) =>
      dbWrite.blurbReference.updateMany({
        where: {
          entityType: first.entityType,
          entityId: first.entityId,
          blurbId: { in: blurbIds },
        },
        // `pendingSince: null` is what takes the row OUT of the selector. Drop it and the job
        // re-selects the same rows on every pass forever.
        data: { materializedHash: contentHash, materializedAt: now, pendingSince: null },
      })
    )
  );
}

// Leaves `materializedHash` stale so the row stays eligible, but bumps `materializedAt` so it
// moves to the back of the `ORDER BY materializedAt ASC` window. That stops a permanently-failing
// row crowding out others once the backlog exceeds `limit`; it does not reduce retries, since a
// backlog under `limit` selects every stale row on every run.
function recordFailure(ref: Ref) {
  return dbWrite.blurbReference.update({
    where: {
      blurbId_entityType_entityId: {
        blurbId: ref.blurbId,
        entityType: ref.entityType,
        entityId: ref.entityId,
      },
    },
    data: { materializedAt: new Date() },
  });
}

export type BlurbFanoutCounts = {
  /**
   * Counted in REFERENCE ROWS, not entities, so `rewritten + skipped + gone + conflict + failed`
   * is the size of what the selector returned and the job can still compare it against its LIMIT.
   * The work is per entity, so every row of one entity carries that entity's outcome.
   */
  rewritten: number;
  skipped: number;
  gone: number;
  failed: number;
  /**
   * The entity was saved by someone else between our load and our save, so nothing was written and
   * the rows stay pending for the next pass. A steady trickle is healthy — it is the guard doing
   * its job. A rising one means the job is contending with interactive saves.
   */
  conflict: number;
  /**
   * Table-wide, not batch-scoped — how many BlurbReference rows currently have no
   * registered adapter. `null` when this pass didn't check (see `includeUnsupportedBacklog`).
   */
  unsupportedBacklog: number | null;
};

export async function runBlurbFanout({
  limit = 500,
  includeUnsupportedBacklog = true,
}: { limit?: number; includeUnsupportedBacklog?: boolean } = {}): Promise<BlurbFanoutCounts> {
  const supportedTypes = getSupportedBlurbEntityTypes();

  // Excluding unsupported entityTypes from the selector itself (rather than letting them
  // into the batch and discarding them per-row) is what stops them starving the queue: a
  // row processBlurbEntity can't rewrite never gets its materializedAt touched, so an
  // in-batch reject would permanently occupy the head of the `ORDER BY materializedAt`
  // window once there were `limit` of them.
  //
  // 🔴 Staleness is `pendingSince IS NOT NULL`, NOT a hash comparison. The obvious predicate —
  // `r."materializedHash" <> b."contentHash"` — is a cross-table inequality that no index on
  // BlurbReference can evaluate, so the planner estimates it at selectivity 1.0 and every plan
  // shape is linear in the whole table, on a job that runs every 5 minutes whether or not there
  // is work. `BlurbReference_pending_idx` is partial on exactly this predicate, so a quiet tick
  // is one empty index probe. The consequence: anything that changes `Blurb.content` MUST stamp
  // `pendingSince` (`markReferencesPending` in blurb.service) — a raw backfill that skips it is
  // invisible to this job, where the hash comparison would have self-healed.
  const stale = await dbRead.$queryRaw<StaleRow[]>`
    SELECT r."blurbId", r."entityType", r."entityId", r."materializedHash",
           b.id, b.content, b."contentHash", b."deletedAt"
    FROM "BlurbReference" r
    JOIN "Blurb" b ON b.id = r."blurbId"
    WHERE r."pendingSince" IS NOT NULL
      AND r."entityType" = ANY(${supportedTypes}::text[])
    ORDER BY r."materializedAt" ASC
    LIMIT ${limit}
  `;

  const byEntity = new Map<string, StaleRow[]>();
  for (const row of stale) {
    const key = `${row.entityType} ${row.entityId}`;
    const group = byEntity.get(key);
    if (group) group.push(row);
    else byEntity.set(key, [row]);
  }

  const counts: BlurbFanoutCounts = {
    rewritten: 0,
    skipped: 0,
    gone: 0,
    failed: 0,
    conflict: 0,
    unsupportedBacklog: null,
  };

  await limitConcurrency(
    [...byEntity.values()].map((rows) => async () => {
      // A single entity's adapter `save` can throw for reasons that have nothing to do with
      // fan-out logic — e.g. Task 6's blocked-link-domain guard now runs against the
      // whole article body on every save, and an article can gain a newly-blocklisted
      // domain long after it was written. `limitConcurrency` rejects its WHOLE batch on
      // the first thrown error (see concurrency-helpers.ts), so without this catch one
      // such entity would abort every other one in the same pass, forever, on every run.
      try {
        const outcome = await processBlurbEntity(rows);
        if (outcome === 'unsupported') counts.failed += rows.length;
        else counts[outcome] += rows.length;
      } catch (error) {
        counts.failed += rows.length;
        const err = error as Error;
        // `warn`, not `error`: a permanently-failing entity logs this on every run, and the job's
        // aggregate log already warns on a nonzero `failed`.
        await logToAxiom({
          type: 'error',
          level: 'warn',
          name: 'blurb-fanout-row',
          message: err.message,
          stack: err.stack,
          blurbIds: rows.map((r) => r.blurbId),
          entityType: rows[0].entityType,
          entityId: rows[0].entityId,
        }).catch(() => undefined);
        for (const row of rows) {
          try {
            await recordFailure(row);
          } catch {
            // best effort: a row that keeps its old materializedAt is simply retried next pass
          }
        }
      }
    }),
    5
  );

  // `NOT (… = ANY(…))` can't range-scan, but `pendingSince IS NOT NULL` puts this on the same
  // partial index as the selector, so it now costs a scan of the BACKLOG rather than of the
  // table. `null` here means this pass didn't look, not that the backlog is empty.
  if (includeUnsupportedBacklog) {
    const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM "BlurbReference" r
      WHERE r."pendingSince" IS NOT NULL
        AND NOT (r."entityType" = ANY(${supportedTypes}::text[]))
    `;
    counts.unsupportedBacklog = count;
  }

  // A soft-deleted blurb whose references are all gone has nothing left to unwrap.
  await dbWrite.$executeRaw`
    DELETE FROM "Blurb" b
    WHERE b."deletedAt" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "BlurbReference" r WHERE r."blurbId" = b.id)
  `;

  return counts;
}
