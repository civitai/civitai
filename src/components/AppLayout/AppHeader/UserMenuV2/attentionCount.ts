import type { UserMenuBadgeItemId } from '~/shared/constants/user-menu.constants';

/** One count per mutable item, so a new one cannot be added to the ids without being counted here. */
export type AttentionCounts = Record<UserMenuBadgeItemId, number | undefined>;

/** What lights the avatar: every waiting count except the ones the viewer muted. */
export function attentionCount(counts: AttentionCounts, muted: readonly UserMenuBadgeItemId[]) {
  return (Object.keys(counts) as UserMenuBadgeItemId[]).reduce(
    (total, id) => total + (muted.includes(id) ? 0 : counts[id] ?? 0),
    0
  );
}

/** The counts query's fields, as the count each mutable item shows. */
export function toAttentionCounts(counts: {
  pendingPlacements?: number;
  pendingCollectionReviews?: number;
  unopenedBoxes?: number;
  unclaimedPrizes?: number;
}): AttentionCounts {
  return {
    placements: counts.pendingPlacements,
    collections: counts.pendingCollectionReviews,
    inventory: counts.unopenedBoxes,
    prizes: counts.unclaimedPrizes,
  };
}
