import type { PlacementSurface, PlacementTargetType } from '~/shared/utils/placement';
import { FREE_SLOT_HOLDING_STATUSES, freePlacementDayStart } from '~/shared/utils/placement';

// The free-tier count predicates, once each. The claim's in-transaction Prisma counts and their
// display-only Kysely twins (`countPlacements` under `kysely-placement-reads`) both take these
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
