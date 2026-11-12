import { Prisma } from '@prisma/client';
import {
  constants,
  PRE_PUBLISH_REVIEW_BASE_MODELS,
  requiresPrePublishReview,
} from '~/server/common/constants';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { dbWrite } from '~/server/db/client';
import { GATE_REFUSAL_MESSAGES } from '~/server/services/pre-publish-gate/messages';
import { throwBadRequestError, throwConflictError } from '~/server/utils/errorHandling';

/**
 * The gate reads base models before the publish's transaction, so an edit can move a version onto a
 * gated one in between. Under the publish's lock, refuse any version gated now that the gate did not
 * judge; the retry runs the gate on it.
 */
export async function assertGatedVersionsJudged(
  tx: Prisma.TransactionClient,
  versionIds: number[],
  judgedVersionIds: number[]
) {
  if (!versionIds.length) return;
  const rows = await tx.$queryRaw<{ id: number; baseModel: string }[]>`
    SELECT id, "baseModel" FROM "ModelVersion"
    WHERE id IN (${Prisma.join(versionIds)})
    FOR SHARE
  `;
  if (rows.some((v) => requiresPrePublishReview(v.baseModel) && !judgedVersionIds.includes(v.id)))
    throw throwConflictError('This version changed while it was being published. Try again.');
  const gatedIds = rows.filter((v) => requiresPrePublishReview(v.baseModel)).map((v) => v.id);
  // The gate judged the model not mature; a save since then must not ride the publish out.
  if (gatedIds.length) {
    const [model] = await tx.$queryRaw<{ nsfw: boolean | null }[]>`
      SELECT m.nsfw FROM "Model" m
      WHERE m.id IN (SELECT "modelId" FROM "ModelVersion" WHERE id IN (${Prisma.join(gatedIds)}))
      LIMIT 1
    `;
    if (model?.nsfw) throw throwBadRequestError(GATE_REFUSAL_MESSAGES.nsfw);
  }
  await assertGatedLinkTargets(
    tx,
    rows.filter((v) => requiresPrePublishReview(v.baseModel)).map((v) => v.id)
  );
}

// A version on a gated base model serves its linked components as its own files, so a link may point
// only where the files can't change: an official component, or a live version on a gated base model,
// which the same guards freeze.
const reviewedTargetSql = (target: Prisma.Sql) => Prisma.sql`(
  EXISTS (SELECT 1 FROM "Model" tm WHERE tm.id = ${target}."modelId" AND tm."userId" = ${
  constants.system.officialUserId
})
  OR (${target}.status IN ('Published', 'Scheduled')
    AND ${target}."baseModel" IN (${Prisma.join([...PRE_PUBLISH_REVIEW_BASE_MODELS])}))
)`;

export const LINK_TARGET_REFUSAL =
  'Components linked to this version can only be official components or other reviewed versions. Remove the link and try again.';

/** Of these target versions, the ones a gated version may not link to (a missing one included). */
export async function disallowedLinkTargets(
  tx: Prisma.TransactionClient,
  targetVersionIds: number[]
) {
  if (!targetVersionIds.length) return [];
  const allowed = await tx.$queryRaw<{ id: number }[]>`
    SELECT t.id FROM "ModelVersion" t
    WHERE t.id IN (${Prisma.join(targetVersionIds)}) AND ${reviewedTargetSql(Prisma.sql`t`)}
  `;
  const ok = new Set(allowed.map((r) => r.id));
  return targetVersionIds.filter((id) => !ok.has(id));
}

/** Refuses publishing a gated version that links anywhere but an allowed target. */
export async function assertGatedLinkTargets(
  tx: Prisma.TransactionClient,
  gatedVersionIds: number[]
) {
  if (!gatedVersionIds.length) return;
  const [bad] = await tx.$queryRaw<{ id: number }[]>`
    SELECT rr."sourceId" AS id FROM "RecommendedResource" rr
    LEFT JOIN "ModelVersion" t ON t.id = rr."resourceId"
    WHERE rr."sourceId" IN (${Prisma.join(gatedVersionIds)})
      AND rr.settings->>'isLinkedComponent' = 'true'
      AND (t.id IS NULL OR NOT ${reviewedTargetSql(Prisma.sql`t`)})
    LIMIT 1
  `;
  if (bad) throw throwBadRequestError(LINK_TARGET_REFUSAL);
}

/** Whether a live version on a gated base model links to any of these versions. */
export async function isLinkTargetOfLiveGatedVersion(
  tx: Prisma.TransactionClient,
  versionIds: number[]
) {
  if (!versionIds.length) return false;
  const [hit] = await tx.$queryRaw<{ id: number }[]>`
    SELECT rr.id FROM "RecommendedResource" rr
    JOIN "ModelVersion" s ON s.id = rr."sourceId"
    WHERE rr."resourceId" IN (${Prisma.join(versionIds)})
      AND rr.settings->>'isLinkedComponent' = 'true'
      AND s.status IN ('Published', 'Scheduled')
      AND s."baseModel" IN (${Prisma.join([...PRE_PUBLISH_REVIEW_BASE_MODELS])})
    LIMIT 1
  `;
  return !!hit;
}

/**
 * The gate judged a live version as not mature; an owner's save can't make its model mature
 * afterwards. Run under the save's model row lock, which a gated publish also takes.
 */
export async function assertOwnerMayMarkMature(
  modelId: number,
  db: Prisma.TransactionClient | typeof dbWrite = dbWrite
) {
  const live = await db.modelVersion.findFirst({
    where: {
      modelId,
      status: { in: [ModelStatus.Published, ModelStatus.Scheduled] },
      baseModel: { in: [...PRE_PUBLISH_REVIEW_BASE_MODELS] },
    },
    select: { id: true },
  });
  if (live) throw throwBadRequestError(GATE_REFUSAL_MESSAGES.nsfw);
}
