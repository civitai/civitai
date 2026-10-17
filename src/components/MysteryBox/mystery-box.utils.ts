import type { BoxOdds } from '@civitai/shared/box-odds';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import type { RouterOutput } from '~/types/router';

export type MysteryBoxView = RouterOutput['mysteryBox']['getForEvent'][number];
export type MysteryBoxTier = MysteryBoxView['tiers'][number];
export type MysteryBoxContent = MysteryBoxView['contents'][number];
export type MysteryBoxOpenResult = RouterOutput['mysteryBox']['open'];

/** Rarity colours for a tier with none of its own, rarest last. */
const FALLBACK_TIER_COLORS = ['#9ca3af', '#22c55e', '#3b82f6', '#f59e0b'];

export function tierColor(tier: Pick<MysteryBoxTier, 'color' | 'sortOrder'>) {
  return tier.color ?? FALLBACK_TIER_COLORS[Math.min(tier.sortOrder, 3)] ?? FALLBACK_TIER_COLORS[0];
}

/** The viewer's odds: the shared rule the draw uses, over what is left for them. */
export function boxOddsFor(view: Pick<MysteryBoxView, 'tiers' | 'contents'>): BoxOdds {
  return computeBoxOdds(
    view.tiers,
    view.contents.filter((c) => c.left)
  );
}

export type TierSummary = {
  tier: MysteryBoxTier;
  contents: MysteryBoxContent[];
  left: number;
  /** 0 once nothing is left in it. */
  probability: number;
  itemProbability: number;
};

/** Every tier, rarest first (the draw walks them the other way), with the viewer's odds. */
export function tierSummaries(view: Pick<MysteryBoxView, 'tiers' | 'contents'>): TierSummary[] {
  const odds = boxOddsFor(view);
  return [...view.tiers]
    .sort((a, b) => b.sortOrder - a.sortOrder || b.id - a.id)
    .map((tier) => {
      const contents = view.contents.filter((c) => c.tierId === tier.id);
      const live = odds.tiers.find((t) => t.tierId === tier.id);
      return {
        tier,
        contents,
        left: contents.filter((c) => c.left).length,
        probability: live?.probability ?? 0,
        itemProbability: live?.itemProbability ?? 0,
      };
    });
}

export function collectedCount(view: Pick<MysteryBoxView, 'contents'>) {
  const left = view.contents.filter((c) => c.left).length;
  return { collected: view.contents.length - left, left, total: view.contents.length };
}

/**
 * What the viewer can do with a box. Buying needs more left than the boxes they already hold (the
 * purchase refuses otherwise); a held box opens while anything is left.
 */
export function boxActions(view: Pick<MysteryBoxView, 'contents' | 'heldBoxItemIds' | 'listing'>) {
  const { left } = collectedCount(view);
  const held = view.heldBoxItemIds.length;
  return {
    complete: left === 0,
    canOpen: held > 0 && left > 0,
    canBuy: !!view.listing && left > held,
    /** Held boxes already cover everything left. */
    covered: !!view.listing && held > 0 && left > 0 && left <= held,
  };
}

/** The chance the opened reward had, from the draw's own record. */
export function revealChance(odds: MysteryBoxOpenResult['odds']) {
  return odds.tierWeight / odds.eligibleWeight / odds.tierPoolSize;
}

/** The view after an open: the drawn reward is no longer left, and the box is no longer held. */
export function afterOpen(view: MysteryBoxView, result: MysteryBoxOpenResult): MysteryBoxView {
  return {
    ...view,
    contents: view.contents.map((c) =>
      c.contentId === result.contentId ? { ...c, left: false } : c
    ),
    heldBoxItemIds: view.heldBoxItemIds.filter((id) => id !== result.boxItemId),
  };
}

/** The open grants the hat under this claim key. */
export const boxOpenClaimKey = (boxItemId: string) => `box-open-${boxItemId}`;

export function formatChance(probability: number, digits = 2) {
  if (probability <= 0) return '0%';
  const pct = probability * 100;
  return `${pct < 0.01 ? '<0.01' : pct.toFixed(pct >= 10 ? 0 : digits)}%`;
}
