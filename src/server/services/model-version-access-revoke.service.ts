import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import type { RevokeUserEarlyAccessInput } from '~/server/schema/model-version.schema';
import { revokeModelVersionAccess } from '~/server/services/model-version-access.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';

/**
 * A moderator takes away one user's early-access grant to one model version. It refunds nothing:
 * any refund is made separately. A grant that is already gone is a no-op, not an error.
 */
export async function moderatorRevokeEarlyAccess({
  moderatorId,
  userId,
  modelVersionId,
  reason,
}: RevokeUserEarlyAccessInput & { moderatorId: number }) {
  // Whether anything was revoked is decided by the delete's own count, not these reads, so a row
  // that vanishes in between is never logged as revoked.
  const [grant, version] = await Promise.all([
    // primary: the grant as it stands just before the delete, for the log.
    dbWrite.entityAccess.findUnique({
      where: {
        accessToId_accessToType_accessorId_accessorType: {
          accessToId: modelVersionId,
          accessToType: 'ModelVersion',
          accessorId: userId,
          accessorType: 'User',
        },
      },
      select: { permissions: true, meta: true, addedAt: true },
    }),
    dbRead.modelVersion.findUnique({ where: { id: modelVersionId }, select: { modelId: true } }),
  ]);

  const removed = await revokeModelVersionAccess({ userId, modelVersionId });
  if (removed === 0) return { revoked: false as const };

  await trackModActivity(moderatorId, {
    entityType: 'modelVersion',
    activity: 'revokeEarlyAccess',
    entityId: modelVersionId,
  });
  logToAxiom({
    type: 'info',
    name: 'moderator-revoke-early-access',
    moderatorId,
    userId,
    modelVersionId,
    reason,
    // One string, not new keys: the dataset is at its field limit.
    details: JSON.stringify(grant),
  });
  // The purchase path's bust, so the revoked user stops being served the version. Guarded: the row is
  // already gone, so a retry would be a no-op and never reach this bust again.
  try {
    await bustMvCache(modelVersionId, version?.modelId, userId);
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'moderator-revoke-early-access-bust',
      error: safeError(error),
      modelVersionId,
      userId,
    });
  }

  return { revoked: true as const, permissions: grant?.permissions ?? null };
}
