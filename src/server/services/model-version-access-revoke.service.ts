import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import type { RevokeUserEarlyAccessInput } from '~/server/schema/model-version.schema';
import { archiveModelVersionAccess } from '~/server/services/model-version-access.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';

/**
 * A moderator takes away one user's early access to one model version, refunding nothing. Use only
 * when the purchase is refunded separately: the unpublish refund will not refund it afterwards. The
 * user's gift claims on the version are marked revoked too (nothing is deleted), so a claimed link
 * can't re-grant it. A grant already revoked, or never there, is a no-op.
 */
export async function moderatorRevokeEarlyAccess({
  moderatorId,
  userId,
  modelVersionId,
  reason,
}: RevokeUserEarlyAccessInput & { moderatorId: number }) {
  const revoked = await dbWrite.$transaction(async (tx) => {
    const before = await archiveModelVersionAccess({
      client: tx,
      userId,
      modelVersionId,
      revokedById: moderatorId,
    });
    if (!before) return null;
    await tx.$executeRaw`
      UPDATE "ModelVersionGiftRedemption" r
         SET "revokedAt" = now(), "revokedById" = ${moderatorId}
        FROM "ModelVersionGiftLink" l
       WHERE l.id = r."giftLinkId" AND l."modelVersionId" = ${modelVersionId}
         AND r."userId" = ${userId} AND r."revokedAt" IS NULL
    `;
    return before;
  });
  if (!revoked) return { revoked: false as const };

  logToAxiom({
    type: 'info',
    name: 'moderator-revoke-early-access',
    moderatorId,
    userId,
    modelVersionId,
    reason,
    // One string, not new keys: the dataset is at its field limit.
    details: JSON.stringify(revoked),
  });
  // The revoke is committed and a retry is a no-op, so a failed step is logged, not thrown or retried.
  const afterRevoke = async (step: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: `moderator-revoke-early-access-${step}`,
        error: safeError(error),
        modelVersionId,
        userId,
      });
    }
  };
  const version = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: { modelId: true },
  });
  await afterRevoke('bust', () => bustMvCache(modelVersionId, version?.modelId, userId));
  await afterRevoke('activity', () =>
    trackModActivity(moderatorId, {
      entityType: 'modelVersion',
      activity: 'revokeEarlyAccess',
      entityId: modelVersionId,
    })
  );

  return { revoked: true as const, permissions: revoked.permissions };
}
