import type { BoxOdds } from '@civitai/shared/box-odds';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import type { RouterOutput } from '~/types/router';

export type MysteryBoxView = RouterOutput['mysteryBox']['getForEvent'][number];
export type MysteryBoxTier = MysteryBoxView['tiers'][number];
export type MysteryBoxContent = MysteryBoxView['contents'][number];
export type MysteryBoxOpenResult = RouterOutput['mysteryBox']['open'];
export type MysteryBoxOddsPageData = NonNullable<RouterOutput['mysteryBox']['getOddsPage']>;
export type MysteryBoxCatalogView = RouterOutput['mysteryBox']['getCatalogForEvent'][number];

/** What the odds read of a content: its tier, and whether it is still left. */
export type OddsContent = Pick<MysteryBoxContent, 'contentId' | 'tierId' | 'left'>;
type OddsView<C extends OddsContent> = { tiers: MysteryBoxTier[]; contents: C[] };

/** What a box says about itself when it has no description. */
export const MYSTERY_BOX_FALLBACK_DESCRIPTION = "1 random hat you don't own yet.";

/** Rarity colours for a tier with none of its own, rarest last. */
const FALLBACK_TIER_COLORS = ['#9ca3af', '#22c55e', '#3b82f6', '#f59e0b'];

export function tierColor(tier: Pick<MysteryBoxTier, 'color' | 'sortOrder'>) {
  return tier.color ?? FALLBACK_TIER_COLORS[Math.min(tier.sortOrder, 3)] ?? FALLBACK_TIER_COLORS[0];
}

/** The viewer's odds: the shared rule the draw uses, over what is left for them. */
export function boxOddsFor(view: OddsView<OddsContent>): BoxOdds {
  return computeBoxOdds(
    view.tiers,
    view.contents.filter((c) => c.left)
  );
}

export type TierSummary<C extends OddsContent = MysteryBoxContent> = {
  tier: MysteryBoxTier;
  contents: C[];
  left: number;
  /** 0 once nothing is left in it. */
  probability: number;
  itemProbability: number;
};

/** Every tier, rarest first (the draw walks them the other way), with the viewer's odds. */
export function tierSummaries<C extends OddsContent>(view: OddsView<C>): TierSummary<C>[] {
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
export function afterOpen<T extends MysteryBoxView>(view: T, result: MysteryBoxOpenResult): T {
  return {
    ...view,
    contents: view.contents.map((c) =>
      c.contentId === result.contentId ? { ...c, left: false } : c
    ),
    heldBoxItemIds: view.heldBoxItemIds.filter((id) => id !== result.boxItemId),
  };
}

export type HeldMysteryBox = RouterOutput['mysteryBox']['getHeld'][number];

/** Where a box modal reads its boxes: an event page's, or every box the viewer holds. */
export type MysteryBoxSource = { event: string } | { inventory: true };

export function afterHeldOpen(view: HeldMysteryBox, result: MysteryBoxOpenResult): HeldMysteryBox {
  return {
    ...afterOpen(view, result),
    heldItems: view.heldItems.filter((item) => item.id !== result.boxItemId),
  };
}

export function boxEventOf(source: MysteryBoxSource, view?: MysteryBoxView | HeldMysteryBox) {
  if ('event' in source) return source.event;
  return view && 'event' in view ? view.event ?? undefined : undefined;
}

/** Shelf prices by cosmetic id, from the shop's sections. */
export function shelfPricesByCosmetic(
  sections: {
    items: { shopItem: { unitAmount: number; cosmetic?: { id: number } | null } }[];
  }[] = []
): Record<number, number> {
  const prices: Record<number, number> = {};
  for (const section of sections)
    for (const { shopItem } of section.items)
      if (shopItem.cosmetic) prices[shopItem.cosmetic.id] = shopItem.unitAmount;
  return prices;
}

export function formatChance(probability: number, digits = 2) {
  if (probability <= 0) return '0%';
  const pct = probability * 100;
  if (pct < 0.01) return '<0.01%';
  const text = pct.toFixed(pct >= 10 ? 0 : digits);
  // An uncertain chance never reads as certain.
  return probability < 1 && Number(text) >= 100 ? '>99%' : `${text}%`;
}

/** The box's public odds page, on the viewer's team when the box has teams. */
export function mysteryBoxOddsPageUrl(view: Pick<MysteryBoxView, 'boxDefinitionId' | 'team'>) {
  const path = `/mystery-boxes/${view.boxDefinitionId}`;
  return view.team ? `${path}?team=${encodeURIComponent(view.team)}` : path;
}

/** One team's view of the box (or the whole box, without teams), as if nothing were owned yet. */
export function baseOddsView<C extends { team: string | null }>(
  page: { tiers: MysteryBoxTier[]; contents: C[] },
  team?: string
) {
  return {
    tiers: page.tiers,
    contents: page.contents
      .filter((c) => c.team === null || team === undefined || c.team === team)
      .map((c) => ({ ...c, left: true })),
  };
}

/**
 * The tier odds every team has before it owns anything, or null when they differ by team (a team
 * with nothing in some tier). For a viewer not on a team, who can't be shown their own.
 */
export function sharedBaseTierOdds(
  box: Pick<MysteryBoxCatalogView, 'tiers' | 'contents' | 'teams'>
) {
  // The event's teams too: a team with nothing of its own in the box draws the shared contents only.
  const teams = [
    ...new Set([...box.teams, ...box.contents.flatMap((c) => (c.team ? [c.team] : []))]),
  ];
  const perTeam = (teams.length ? teams : [undefined]).map((team) =>
    tierSummaries(baseOddsView(box, team))
  );
  const odds = (summary: TierSummary<OddsContent>[]) =>
    summary.map((t) => `${t.tier.id}:${t.probability}`).join('|');
  return perTeam.every((summary) => odds(summary) === odds(perTeam[0])) ? perTeam[0] : null;
}
