import { milestoneRung } from '~/server/services/creator-milestone-registry';
import { SCORE_TIERS, scoreTierSlugFromKey } from '~/shared/constants/creator-journey.constants';

type EarnedBadge = { key: string; track: string; achievedAt: Date | null };

const tierRank = (key: string) => {
  const slug = scoreTierSlugFromKey(key);
  return slug ? SCORE_TIERS.findIndex((tier) => tier.slug === slug) : -1;
};

/**
 * Where an undated badge goes among the undated: score tiers first, highest first; then activity
 * badges by metal, diamond first, whatever the track; then hidden ones. Lower sorts first.
 */
function undatedPlace(badge: EarnedBadge): [number, number] {
  if (badge.track === 'score') return [0, -tierRank(badge.key)];
  const rung = badge.track === 'secret' ? null : milestoneRung(badge.key);
  return rung === null ? [2, 0] : [1, -rung];
}

/**
 * Badges with an observed earned date come first, newest first. Backfilled ones (granted at launch
 * to creators already past the bar, so no real date) follow, best first. Stable for ties.
 */
export function compareEarnedBadges(a: EarnedBadge, b: EarnedBadge) {
  if (a.achievedAt && b.achievedAt) return b.achievedAt.getTime() - a.achievedAt.getTime();
  if (a.achievedAt) return -1;
  if (b.achievedAt) return 1;
  const [aGroup, aRank] = undatedPlace(a);
  const [bGroup, bRank] = undatedPlace(b);
  return aGroup - bGroup || aRank - bRank;
}

export const sortEarnedBadges = <T extends EarnedBadge>(badges: T[]) =>
  [...badges].sort(compareEarnedBadges);
