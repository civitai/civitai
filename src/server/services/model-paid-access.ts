import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';

export type ModelPaidAccessGate = {
  // End of an ACTIVE timed window. Null for a permanent gate, which has no end date.
  earlyAccessDeadline: Date | null;
  permanent: boolean;
};

/**
 * The card badge for both the feed and the search index derives from this, so the two surfaces
 * cannot disagree about whether a model is gated. Kept a leaf — importing it must not pull the
 * model service's graph into the search-index build.
 *
 * `timeframeDays IS NULL` is the permanent discriminator, not `endsAt`: a timed gate carries a NULL
 * `endsAt` until publish materializes it. The rule is owned by `paid-access.service.ts`.
 */
export async function getModelPaidAccessGates(
  modelIds: number[]
): Promise<Map<number, ModelPaidAccessGate>> {
  if (!modelIds.length) return new Map();

  const rows = await dbRead.$queryRaw<
    { modelId: number; deadline: Date | null; permanent: boolean }[]
  >`
    SELECT
      mv."modelId",
      -- Redundant against the predicate below, which already excludes tombstones; it keeps the
      -- aggregate correct on its own, so a permanent gate that ever carried an endsAt could not be
      -- reported as an early-access window. Zero such rows in prod today.
      MAX(pa."endsAt") FILTER (WHERE pa."endsAt" > NOW()) AS deadline,
      bool_or(pa."timeframeDays" IS NULL) AS permanent
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE pa."entityType" = 'ModelVersion'
      AND (pa."endsAt" > NOW() OR pa."timeframeDays" IS NULL)
      AND mv.status = 'Published'::"ModelStatus"
      AND mv."modelId" IN (${Prisma.join(modelIds)})
    GROUP BY mv."modelId"
  `;

  return new Map(
    rows.map((r) => [
      Number(r.modelId),
      { earlyAccessDeadline: r.deadline ?? null, permanent: !!r.permanent },
    ])
  );
}
