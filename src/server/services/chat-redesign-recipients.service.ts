import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

// Mirrors the auth hub's `shapeSessionUser`, which is what produces the `tier` a real
// session hands Flipt. Its ranking puts founder on top, unlike `constants.memberships`.
const TIER_ORDER: Record<string, number> = { founder: 5, gold: 4, silver: 3, bronze: 2, free: 1 };
const ACTIVE_STATUSES = ['active', 'trialing'];

type RecipientRow = {
  id: number;
  isModerator: boolean | null;
  onboarding: number;
  subscriptions: { status: string; product: { metadata: unknown } }[];
  membershipOverride: { tier: string } | null;
};

function highestTier({ subscriptions, membershipOverride }: RecipientRow) {
  const rank = (tier: string | undefined) => (tier ? TIER_ORDER[tier] ?? 0 : 0);
  let highest: string | undefined;
  for (const sub of subscriptions) {
    if (!ACTIVE_STATUSES.includes(sub.status)) continue;
    const metadata = (sub.product.metadata ?? {}) as Record<string, unknown>;
    const tier = env.TIER_METADATA_KEY ? (metadata[env.TIER_METADATA_KEY] as string) : undefined;
    if (tier && tier !== 'free' && rank(tier) > rank(highest)) highest = tier;
  }
  const override = membershipOverride?.tier;
  if (override && override !== 'free' && rank(override) > rank(highest)) highest = override;
  return highest;
}

/**
 * Which of `recipientIds` see the chat redesign, evaluated the way their own request
 * would be: the same `chatRedesign` flag over the Flipt properties their session
 * carries. There is no request here, so host- and region-scoped availability cannot
 * apply; `chatRedesign` uses neither.
 *
 * Fails closed to "not in the redesign": a recipient this cannot place keeps the
 * pre-redesign routing rather than having invites filtered into a tab they cannot see.
 */
export async function getChatRedesignRecipients({
  recipientIds,
  earlyAdopters,
}: {
  recipientIds: number[];
  /** `User.settings.isEarlyAdopter`, which the caller has already read. */
  earlyAdopters: Set<number>;
}): Promise<Set<number>> {
  const inRedesign = new Set<number>();
  if (!recipientIds.length) return inRedesign;

  try {
    const rows: RecipientRow[] = await dbRead.user.findMany({
      where: { id: { in: recipientIds } },
      select: {
        id: true,
        isModerator: true,
        onboarding: true,
        subscriptions: {
          where: { status: { notIn: ['canceled', 'incomplete_expired'] } },
          select: { status: true, product: { select: { metadata: true } } },
        },
        membershipOverride: { select: { tier: true } },
      },
    });

    for (const row of rows) {
      const user = {
        id: row.id,
        isModerator: row.isModerator ?? undefined,
        onboarding: row.onboarding,
        tier: highestTier(row),
        isEarlyAdopter: earlyAdopters.has(row.id) || undefined,
      } as SessionUser;
      if (getFeatureFlagsLazy({ user }).chatRedesign) inRedesign.add(row.id);
    }
  } catch (error) {
    logToAxiom(
      {
        name: (error as Error)?.name,
        message: (error as Error)?.message,
        stack: (error as Error)?.stack,
        path: 'chat.getChatRedesignRecipients',
      },
      'civitai-prod'
    ).catch(() => undefined);
    return new Set();
  }

  return inRedesign;
}
