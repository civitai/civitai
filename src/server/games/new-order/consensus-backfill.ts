export type DecisionClass = 'same_level' | 'up_rate' | 'down_1lvl' | 'down_gt1' | 'unknown_orig';

export function classifyDecision(domRating: number, origLevel: number | null): DecisionClass {
  if (!origLevel || origLevel <= 0) return 'unknown_orig';
  if (domRating === origLevel) return 'same_level';
  if (domRating > origLevel) return 'up_rate';
  const distance = Math.abs(Math.log2(domRating) - Math.log2(origLevel));
  return distance <= 1 ? 'down_1lvl' : 'down_gt1';
}
