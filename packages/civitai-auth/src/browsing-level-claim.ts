/**
 * Whether a token's browsing-level claim value is well-formed: a non-negative integer. A browsing
 * level is a bit flag, so a negative value like -1 has every bit set and would widen to every level.
 */
export const isBrowsingLevelClaim = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;
