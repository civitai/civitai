import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';

/**
 * Batched `hasValidCreatorMembership` for read-time gating across a list of owners
 * (metric-privacy on the model feed / v1 API / search index, and the donation-goal
 * hide). ONE `dbRead` query for all owners — never K per-owner checkouts on the
 * primary pool. Mirrors getHighestTierSubscription + hasValidCreatorMembership: pick
 * each user's highest tier (constants.memberships.tierOrder) and treat
 * non-free / non-founder as valid.
 *
 * Kept in this dependency-light module (dbRead + env + constants + the zod schema, no
 * clickhouse/buzz/notification graph) so the donation-goals lookup can gate on it
 * without dragging the heavy creator-program graph into that light, unit-tested path.
 */
export async function getValidCreatorMembershipMap(userIds: number[]) {
  const unique = [...new Set(userIds.filter((id) => !!id))];
  const result = new Map<number, boolean>();
  if (unique.length === 0) return result;

  const subscriptions = await dbRead.customerSubscription.findMany({
    where: {
      userId: { in: unique },
      status: { notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] },
    },
    select: {
      userId: true,
      metadata: true,
      product: { select: { metadata: true } },
    },
  });

  const tierOrder = constants.memberships.tierOrder as readonly string[];
  const highestTierByUser = new Map<number, string>();
  for (const sub of subscriptions) {
    const subMeta = (sub.metadata ?? {}) as { renewalEmailSent?: boolean };
    if (subMeta.renewalEmailSent) continue;
    const productMeta = subscriptionProductMetadataSchema.parse(sub.product.metadata);
    const tier = (productMeta?.[env.TIER_METADATA_KEY] ?? 'free') as string;
    const prev = highestTierByUser.get(sub.userId);
    if (prev === undefined || tierOrder.indexOf(tier) > tierOrder.indexOf(prev))
      highestTierByUser.set(sub.userId, tier);
  }

  for (const id of unique) {
    const tier = highestTierByUser.get(id);
    result.set(id, !!tier && tier !== 'free' && tier !== 'founder');
  }
  return result;
}
