import type { PlacementSurface, PlacementTargetType } from '~/shared/utils/placement';
import { FREE_SLOT_HOLDING_STATUSES, freePlacementDayStart } from '~/shared/utils/placement';

// The free-tier count predicates, once each. The claim's in-transaction Prisma counts and their
// display-only Kysely counts (`countPlacements`) both take these
// objects, so the two cannot drift. Plain data in their own module: free-placement.service.ts
// exports nothing that could reach its advisory locks.

type SpaceTarget = { surface: PlacementSurface; targetType: PlacementTargetType; targetId: number };

/** Free placements on one space whose status still holds a slot. */
export const reservedFreeSlotsWhere = ({ surface, targetType, targetId }: SpaceTarget) => ({
  surface,
  targetType,
  targetId,
  free: true,
  status: { in: [...FREE_SLOT_HOLDING_STATUSES] },
});

/** A placer's free placements since UTC midnight, every surface and status. */
export const freePlacementsTodayWhere = (placerId: number) => ({
  placerId,
  free: true,
  createdAt: { gte: freePlacementDayStart() },
});

/** A placer's free placements on one space, every status. */
export const freePlacementsOnWhere = ({
  placerId,
  surface,
  targetType,
  targetId,
}: SpaceTarget & { placerId: number }) => ({ placerId, free: true, surface, targetType, targetId });

/**
 * Marker on a free row that an event waiver paid for instead of the free tier, in `Placement.data`.
 * Such a row is free (no escrow, `amount` 0) but spends none of the tier's capacity: the counts
 * above are read net of it through `teamWaivedWhere`.
 */
export const TEAM_WAIVER = 'team';

/**
 * The team-waived rows among those a free-tier predicate matches. A positive JSON match, so a row
 * with no `waiver` key is simply not one: `NOT` over a JSON path would drop those rows too, since
 * the missing key compares NULL.
 */
export const teamWaivedWhere = <W extends object>(where: W) => ({
  ...where,
  data: { path: ['waiver'], equals: TEAM_WAIVER },
});

/**
 * A free-tier count, net of team-waived rows. Two counts in sequence, so a transaction client can
 * run it under its lock; waived rows are a subset of the base, so the difference is exact.
 */
export async function countFreeTier<W extends object>(
  count: (where: W | ReturnType<typeof teamWaivedWhere<W>>) => Promise<number>,
  where: W
) {
  const all = await count(where);
  if (!all) return 0;
  return all - (await count(teamWaivedWhere(where)));
}
