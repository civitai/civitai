import { dbRead, dbWrite } from '~/server/db/client';
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

// A rewrite that fails leaves `materializedHash` stale, so the row is simply
// re-selected on the next pass — no separate retry path needed.
export async function runBlurbFanout({ limit = 500 }: { limit?: number } = {}) {
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

  const counts = { rewritten: 0, skipped: 0, gone: 0, unsupported: 0 };

  await limitConcurrency(
    stale.map((row) => async () => {
      const outcome = await processBlurbReference(row, row);
      counts[outcome]++;
    }),
    5
  );

  // The selector above never returns these rows, so their count has to come from
  // its own query to stay visible — a real misconfiguration (an entityType wired up
  // at the schema layer with no adapter registered) that someone has to notice.
  const [{ count: unsupported }] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM "BlurbReference" r
    WHERE NOT (r."entityType" = ANY(${supportedTypes}::text[]))
  `;
  counts.unsupported = unsupported;

  // A soft-deleted blurb whose references are all gone has nothing left to unwrap.
  await dbWrite.$executeRaw`
    DELETE FROM "Blurb" b
    WHERE b."deletedAt" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "BlurbReference" r WHERE r."blurbId" = b.id)
  `;

  return counts;
}
