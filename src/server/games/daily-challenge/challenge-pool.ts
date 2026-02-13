import type { Prize } from '~/server/schema/challenge.schema';

// =============================================================================
// Dynamic Prize Pool Computation (pure function — no DB/Redis imports)
// =============================================================================
// This file is intentionally free of server-side imports (db, redis, etc.)
// so it can be imported by both server jobs and client components.

const DEFAULT_POINTS_BY_PLACE = [150, 100, 50];

export function computeDynamicPool(input: {
  basePrizePool: number;
  buzzPerAction: number;
  actionCount: number;
  maxPrizePool: number | null;
  prizeDistribution: number[];
}): { totalPool: number; prizes: Prize[] } {
  const { basePrizePool, buzzPerAction, actionCount, maxPrizePool, prizeDistribution } = input;

  let totalPool = basePrizePool + buzzPerAction * actionCount;

  // Apply cap
  if (maxPrizePool != null && totalPool > maxPrizePool) {
    totalPool = maxPrizePool;
  }

  const prizes = prizeDistribution.map((pct, i) => ({
    buzz: Math.floor((totalPool * pct) / 100),
    points: DEFAULT_POINTS_BY_PLACE[i] ?? 0,
  }));

  // Assign rounding remainder to 1st place
  const allocated = prizes.reduce((sum, p) => sum + p.buzz, 0);
  if (allocated < totalPool && prizes.length > 0) {
    prizes[0].buzz += totalPool - allocated;
  }

  return { totalPool, prizes };
}
