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

export type FanoutOutcome = 'rewritten' | 'skipped' | 'gone' | 'unsupported';

export async function processBlurbReference(ref: Ref, blurb: Blurb): Promise<FanoutOutcome> {
  const adapter = getBlurbFanoutAdapter(ref.entityType);
  if (!adapter) return 'unsupported';

  const loaded = await adapter.load(ref.entityId);
  if (!loaded) {
    // A reference can outlive its entity — entityType/entityId is a loose pair, not a
    // foreign key. Dropping it here is what stops one deleted article sitting in the
    // backlog forever and poisoning the backlog-age metric.
    await dropReference(ref);
    return 'gone';
  }

  const deleting = !!blurb.deletedAt;
  const next = deleting
    ? unwrapBlurbSpans(loaded.html, new Set([blurb.id]))
    : replaceBlurbSpans(loaded.html, new Map([[blurb.id, blurb.content]]));

  if (next === loaded.html) {
    if (deleting) await dropReference(ref);
    else await recordReference(ref, blurb.contentHash);
    return 'skipped';
  }

  await adapter.save({ entityId: ref.entityId, userId: loaded.userId, html: next });

  if (deleting) await dropReference(ref);
  else await recordReference(ref, blurb.contentHash);

  return 'rewritten';
}

function dropReference(ref: Ref) {
  return dbWrite.blurbReference.deleteMany({
    where: { blurbId: ref.blurbId, entityType: ref.entityType, entityId: ref.entityId },
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

// Deliberately leaves `materializedHash` untouched — the row is still stale and stays
// eligible — but bumps `materializedAt` so it moves to the BACK of the next pass's
// `ORDER BY materializedAt ASC` window instead of heading it again. A row that fails every
// time (e.g. an article whose body trips the blocked-link-domain guard) is retried once per
// full sweep of the backlog rather than every run, and never on its own; there's no
// separate cap, because the `failed` counter and the row-level log below are what make it
// visible to a person, and a permanent count-then-stop would hide the same row instead.
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
  // row processBlurbReference can't rewrite never gets its materializedAt touched, so an
  // in-batch reject would permanently occupy the head of the `ORDER BY materializedAt`
  // window once there were `limit` of them.
  const stale = await dbRead.$queryRaw<Array<Ref & Blurb>>`
    SELECT r."blurbId", r."entityType", r."entityId", r."materializedHash",
           b.id, b.content, b."contentHash", b."deletedAt"
    FROM "BlurbReference" r
    JOIN "Blurb" b ON b.id = r."blurbId"
    WHERE (r."materializedHash" <> b."contentHash" OR b."deletedAt" IS NOT NULL)
      AND r."entityType" = ANY(${supportedTypes}::text[])
    ORDER BY r."materializedAt" ASC
    LIMIT ${limit}
  `;

  const counts: BlurbFanoutCounts = {
    rewritten: 0,
    skipped: 0,
    gone: 0,
    failed: 0,
    unsupportedBacklog: null,
  };

  await limitConcurrency(
    stale.map((row) => async () => {
      // A single row's adapter `save` can throw for reasons that have nothing to do with
      // fan-out logic — e.g. Task 6's blocked-link-domain guard now runs against the
      // whole article body on every save, and an article can gain a newly-blocklisted
      // domain long after it was written. `limitConcurrency` rejects its WHOLE batch on
      // the first thrown error (see concurrency-helpers.ts), so without this catch one
      // such row would abort every other row in the same pass, forever, on every run.
      try {
        const outcome = await processBlurbReference(row, row);
        // The selector above already filters to supported entityTypes, so `outcome` is
        // never really 'unsupported' here — folding it into `failed` just keeps the type
        // checker honest about processBlurbReference's full return type without a key
        // that doesn't exist on this batch-scoped counter.
        if (outcome === 'unsupported') counts.failed++;
        else counts[outcome]++;
      } catch (error) {
        counts.failed++;
        const err = error as Error;
        await logToAxiom({
          type: 'error',
          name: 'blurb-fanout-row',
          message: err.message,
          stack: err.stack,
          blurbId: row.blurbId,
          entityType: row.entityType,
          entityId: row.entityId,
        }).catch(() => undefined);
        // try/catch, not `.catch()` chained off the call: this already runs inside the
        // handler built to stop one row's failure from escaping, so a second failure here
        // must not escape either. If it fails too, the row keeps its old materializedAt
        // and is simply retried (from the front of the queue) next pass.
        try {
          await recordFailure(row);
        } catch {
          // best effort — see above
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
