/** The tile's share-of-creators line; null when there is no count to show. */
export function rarityLabel(percent: number | null | undefined) {
  if (percent == null) return null;
  if (percent > 0 && percent < 0.1) return '<0.1% of creators';
  const rounded = percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent);
  return `${rounded}% of creators`;
}

export type RevealTier = 'common' | 'rare' | 'epic' | 'special';

// Justin's cutoffs (2026-11-14): common 10% or more, rare 1% to 10%, epic under 1%.
const RARE_BELOW = 10;
const EPIC_BELOW = 1;

/** How big an unlock's reveal is. With no count to go on it is common. */
export function revealTier({
  special,
  rarity,
}: {
  special: boolean;
  rarity: number | null;
}): RevealTier {
  if (special) return 'special';
  if (rarity == null || rarity >= RARE_BELOW) return 'common';
  return rarity < EPIC_BELOW ? 'epic' : 'rare';
}

const tierOrder: Record<RevealTier, number> = { special: 0, epic: 1, rare: 2, common: 3 };

/** Rarest first: specials, then by share of creators, uncounted last. */
export function sortReveals<T extends { special: boolean; rarity: number | null }>(reveals: T[]) {
  return [...reveals].sort(
    (a, b) =>
      tierOrder[revealTier(a)] - tierOrder[revealTier(b)] ||
      (a.rarity ?? Infinity) - (b.rarity ?? Infinity)
  );
}

const isBigReveal = (tier: RevealTier) => tier === 'epic' || tier === 'special';

/** At most this many full-screen moments in one visit; any more wait in the row. */
export const MODAL_LIMIT = 3;

/**
 * Rarest first. Epic and special unlocks get a full-screen moment each, up to MODAL_LIMIT; the rest
 * share one row.
 */
export function splitReveals<T extends { special: boolean; rarity: number | null }>(reveals: T[]) {
  const sorted = sortReveals(reveals);
  const modals = sorted.filter((reveal) => isBigReveal(revealTier(reveal))).slice(0, MODAL_LIMIT);
  return { modals, row: sorted.filter((reveal) => !modals.includes(reveal)) };
}
