import { NewOrderRankType } from '~/shared/utils/prisma/enums';

/**
 * Built-in fallback for `poolQuotas` when Redis config hasn't seeded one.
 * Knight is the only rank that suffers from the SFW/NSFW priority misuse
 * today (see `image-scan-result.ts` routing), so we default it to a 50/50
 * split between Knight1 (SFW) and Knight2 (NSFW). Acolyte/Templar are
 * intentionally omitted to preserve their legacy sequential behavior.
 */
export const DEFAULT_POOL_QUOTAS: Partial<Record<NewOrderRankType, number[]>> = {
  [NewOrderRankType.Knight]: [0.5, 0.5, 0],
};

/**
 * Pure quota-math used by `getImagesQueue` to convert per-pool weights into
 * concrete fetch targets. Filters out pools with zero weight or zero size,
 * renormalizes the remaining weights, floors each target, and pushes the
 * rounding remainder onto the heaviest pool so the totals still trend
 * toward `overflowLimit`.
 *
 * Returned `targets` is indexed parallel to `weights`/`poolSizes`; inactive
 * pools get target=0. `activeIdxs` are the indices that ended up with a
 * positive target — callers can use this list to drive both pass 1 (quota
 * fill) and pass 2 (deficit redistribution to survivors).
 */
export function computePoolTargets({
  weights,
  poolSizes,
  overflowLimit,
}: {
  weights: number[];
  poolSizes: number[];
  overflowLimit: number;
}): { targets: number[]; activeIdxs: number[] } {
  // Size `targets` to the union of both inputs so a length-2 `weights` against
  // a length-3 `poolSizes` (or vice versa) still produces indexable entries
  // for every pool the caller might iterate. Zod blocks the mismatched shape
  // on the API edge today, but the function itself shouldn't trust callers.
  const len = Math.max(weights.length, poolSizes.length);
  const targets = new Array<number>(len).fill(0);
  if (overflowLimit <= 0) return { targets, activeIdxs: [] };

  const activeIdxs: number[] = [];
  for (let idx = 0; idx < len; idx++) {
    if ((weights[idx] ?? 0) > 0 && (poolSizes[idx] ?? 0) > 0) activeIdxs.push(idx);
  }

  if (activeIdxs.length === 0) return { targets, activeIdxs };

  const totalWeight = activeIdxs.reduce((sum, idx) => sum + (weights[idx] ?? 0), 0);
  for (const idx of activeIdxs) {
    targets[idx] = Math.floor((overflowLimit * (weights[idx] ?? 0)) / totalWeight);
  }
  const remainder = overflowLimit - targets.reduce((a, b) => a + b, 0);
  if (remainder > 0) {
    const biggest = activeIdxs.reduce((best, idx) =>
      (weights[idx] ?? 0) > (weights[best] ?? 0) ? idx : best
    );
    targets[biggest] += remainder;
  }

  return { targets, activeIdxs };
}
