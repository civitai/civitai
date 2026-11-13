/** Where a prize notification sends its winner, or undefined when it carries no claimable prize. */
export function getPrizeClaimUrl(details: { prizeId?: number | null; prizeCount?: number | null }) {
  if (details.prizeId) return `/prizes/${details.prizeId}`;
  if (details.prizeCount && details.prizeCount > 0) return '/prizes';
  return undefined;
}
