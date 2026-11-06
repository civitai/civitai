import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import type { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';

/** Whether the owner lets this badge show on their profile. A null id is checked against showBadges only. */
export function isBadgeShownOnProfile(
  privacy: PrivacySettingsSchema | null | undefined,
  cosmeticId: number | null
) {
  if (privacy?.showBadges === false) return false;
  return cosmeticId == null || !privacy?.hiddenBadgeIds?.includes(cosmeticId);
}

/** Drops ids the user no longer owns (expired or replaced badges), keeping the order of the rest. */
export function keepOwnedBadgeIds(ids: number[] | null | undefined, ownedIds: Iterable<number>) {
  const owned = new Set(ownedIds);
  return (ids ?? []).filter((id) => owned.has(id));
}

/**
 * The list to save after the user edits the owned picks: their new picks, then every saved id they
 * don't own right now. Leaderboard and membership badges come and go with the same id, so a hide or
 * pin set earlier must outlive the badge being away.
 */
export function withUnownedBadgeIds(
  picks: number[],
  saved: number[] | null | undefined,
  ownedIds: Iterable<number>
) {
  const owned = new Set(ownedIds);
  return [...picks, ...(saved ?? []).filter((id) => !owned.has(id))];
}

/** A badge's image URL, or '' when it has none. */
export function getBadgeImageUrl(badge: { data: unknown }) {
  return (((badge.data ?? {}) as BadgeCosmetic['data']).url ?? '') as string;
}

/** Keeps the first item for each badge image; items without an image are dropped. */
export function dedupeBadgesByImage<T>(items: T[], getImageUrl: (item: T) => string) {
  const seenUrls = new Set<string>();
  return items.filter((item) => {
    const url = getImageUrl(item);
    if (!url || seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
}

/**
 * Splits a user's owned badges into their highlighted picks (in pick order) and the rest.
 * Badges that share an image show once in the rest, and not at all if a highlighted badge has it —
 * deduping only after the highlight lookup, so a highlighted badge is never the duplicate dropped.
 * The profile editor offers one badge per image, so hiding a badge hides every badge with its image;
 * hidden wins over highlighted.
 */
export function splitProfileBadges<T extends { id: number }>(
  badges: T[],
  privacy: PrivacySettingsSchema | null | undefined,
  getImageUrl: (badge: T) => string
) {
  const hiddenUrls = new Set(
    badges.filter((b) => !isBadgeShownOnProfile(privacy, b.id)).map(getImageUrl)
  );
  const visibleBadges = badges.filter((b) => !hiddenUrls.has(getImageUrl(b)));
  const highlightedBadgeIds = privacy?.highlightedBadgeIds ?? [];
  const highlightedSet = new Set(highlightedBadgeIds);
  const highlightedBadges = highlightedBadgeIds
    .map((id) => visibleBadges.find((b) => b.id === id))
    .filter((b): b is T => !!b);

  const highlightedUrls = new Set(highlightedBadges.map(getImageUrl));
  const otherBadges = dedupeBadgesByImage(
    visibleBadges.filter((b) => !highlightedSet.has(b.id) && !highlightedUrls.has(getImageUrl(b))),
    getImageUrl
  );

  return { highlightedBadges, otherBadges };
}
