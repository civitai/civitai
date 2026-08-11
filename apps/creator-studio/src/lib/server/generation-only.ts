import type { SessionUser } from '@civitai/auth';
import { sql } from '@civitai/db/kysely';
import { dbRead } from '$lib/server/db';
import { canSetGenerationOnly, tierGrantsGenerationOnly } from '$lib/server/membership';

// The session tier lags a membership change, so a creator who just upgraded would be refused here while
// the main app — which re-resolves the feature flag off the fresh subscription tier — accepts them. The
// DB read only happens when the session already says no: the answer can only go from false to true.
//
// Split from membership.ts so that file stays free of a db import; its unit tests load it directly.
export async function canSetGenerationOnlyFresh(user: SessionUser | undefined): Promise<boolean> {
  if (!user) return false;
  if (canSetGenerationOnly(user)) return true;
  return tierGrantsGenerationOnly(await freshSubscriptionTier(user.id));
}

// Mirrors the main app's getCapTier: the tier on a subscription still in good standing. Keep the status
// list in step with subscriptions.service.
async function freshSubscriptionTier(userId: number): Promise<string | null> {
  const row = await dbRead
    .selectFrom('CustomerSubscription as cs')
    .innerJoin('Product as p', 'p.id', 'cs.productId')
    .select(sql<string | null>`p.metadata->>'tier'`.as('tier'))
    .where('cs.userId', '=', userId)
    .where('cs.status', 'not in', ['canceled', 'incomplete_expired', 'past_due', 'unpaid'])
    .executeTakeFirst();
  return row?.tier ?? null;
}
