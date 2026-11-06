import { isNonCommercialBaseModel } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Refuses to publish a version on a non-commercial base model while it still carries a licensing fee
 * or an open paid-access gate. The version writes already refuse these, but a fee or gate stored before
 * its base model's licence was flagged would otherwise go live with it, and a pending timed gate would
 * start early access at publish.
 */
export async function assertNonCommercialVersionsUnmonetized(
  versions: { id: number; baseModel: string | null }[]
) {
  const nonCommercial = versions.filter((v) => isNonCommercialBaseModel(v.baseModel));
  if (!nonCommercial.length) return;
  const ids = nonCommercial.map((v) => v.id);

  const [feed, gated] = await Promise.all([
    dbWrite.modelVersion.findMany({
      where: { id: { in: ids }, licensingFee: { gt: 0 } },
      select: { id: true },
    }),
    dbWrite.paidAccess.findMany({
      where: {
        entityType: 'ModelVersion',
        entityId: { in: ids },
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      select: { entityId: true },
    }),
  ]);
  const monetized = new Set([...feed.map((v) => v.id), ...gated.map((g) => g.entityId)]);
  const blocked = nonCommercial.find((v) => monetized.has(v.id));
  if (!blocked) return;

  throw throwBadRequestError(
    `The base model "${blocked.baseModel}" is licensed for non-commercial use. Remove this version's licensing fee and paid or early access before publishing it.`
  );
}
