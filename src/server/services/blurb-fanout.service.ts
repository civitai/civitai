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

export type FanoutOutcome = 'rewritten' | 'skipped' | 'gone' | 'unsupported';

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
  if (rewritten)
    await adapter.save({ entityId: first.entityId, userId: loaded.userId, html: next });

  const deleted = rows.filter((row) => row.deletedAt);
  if (deleted.length) await dropReferences(deleted);
  for (const row of rows) {
    if (!row.deletedAt) await recordReference(row, row.contentHash);
  }

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

function recordReference(ref: Ref, contentHash: string) {
  return dbWrite.blurbReference.update({
    where: {
      blurbId_entityType_entityId: {
        blurbId: ref.blurbId,
        entityType: ref.entityType,
        entityId: ref.entityId,
      },
    },
    data: { materializedHash: contentHash, materializedAt: new Date() },
  });
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
   * Counted in REFERENCE ROWS, not entities, so `rewritten + skipped + gone + failed` is the size
   * of what the selector returned and the job can still compare it against its LIMIT. The work is
   * per entity, so every row of one entity carries that entity's outcome.
   */
  rewritten: number;
  skipped: number;
  gone: number;
  failed: number;
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
  const stale = await dbRead.$queryRaw<StaleRow[]>`
    SELECT r."blurbId", r."entityType", r."entityId", r."materializedHash",
           b.id, b.content, b."contentHash", b."deletedAt"
    FROM "BlurbReference" r
    JOIN "Blurb" b ON b.id = r."blurbId"
    WHERE (r."materializedHash" <> b."contentHash" OR b."deletedAt" IS NOT NULL)
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

  // `NOT (… = ANY(…))` can't range-scan, so this is linear in table size — the caller
  // decides how often it's worth paying for that (see the job's cadence comment). `null`
  // here means this pass didn't look, not that the backlog is empty.
  if (includeUnsupportedBacklog) {
    const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM "BlurbReference" r
      WHERE NOT (r."entityType" = ANY(${supportedTypes}::text[]))
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
