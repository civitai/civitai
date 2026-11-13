import {
  CREATOR_BOX_TIERS,
  CREATOR_BOX_WORST_DRAW_MULTIPLE,
  type CreatorBoxPriceBounds,
  creatorBoxPriceBounds,
  creatorBoxPriceProblem,
  creatorBoxWeights,
  type CreatorBoxSteepness,
} from '@civitai/shared/creator-box-rules';
import { tierSummaries } from '~/components/MysteryBox/mystery-box.utils';
import { COSMETIC_PRICE_FLOOR_MIN } from '~/server/schema/creator-shop.schema';

/** What the composer edits: cosmetic ids by tier, commonest first, and how steep the odds are. */
export type MysteryPackDraft = { steepness: CreatorBoxSteepness; tiers: number[][] };

/**
 * What the creator sees while building, from the same rules the server checks at submit and
 * approve (`creator-box-rules`), so a green preview is not refused for the layout or the price.
 * `values` holds each valid item's value; an item missing from it blocks the bounds.
 */
export function previewMysteryPack(
  draft: MysteryPackDraft,
  values: ReadonlyMap<number, number>,
  price: number | undefined
) {
  const layout = creatorBoxWeights(
    draft.tiers.map((tier) => tier.length),
    draft.steepness
  );
  const names = CREATOR_BOX_TIERS[draft.tiers.length];
  const ids = draft.tiers.flat();
  const allValued = ids.every((id) => values.has(id));

  const odds =
    layout.ok && names
      ? tierSummaries({
          tiers: draft.tiers.map((_, t) => ({
            id: t + 1,
            key: names[t].key,
            name: names[t].name,
            color: null,
            weight: layout.weights[t],
            sortOrder: t,
          })),
          contents: draft.tiers.flatMap((tier, t) =>
            tier.map((cosmeticId) => ({ contentId: cosmeticId, tierId: t + 1, left: true }))
          ),
        })
      : [];

  const bounds =
    layout.ok && allValued
      ? creatorBoxPriceBounds(
          draft.tiers.map((tier, t) => ({
            weight: layout.weights[t],
            values: tier.map((id) => values.get(id)!),
          })),
          COSMETIC_PRICE_FLOOR_MIN
        )
      : null;
  const priceProblem = bounds ? priceMessage(price, bounds) : null;
  return {
    layoutProblem: layout.ok ? null : layout.reason,
    odds,
    bounds,
    priceProblem,
    ready: layout.ok && !!bounds && !priceProblem,
  };
}

/**
 * The shared check's reason, except when the price is over the allowed maximum: it names the
 * average even where the worst-draw bound is the tighter one, which would contradict the range shown.
 */
function priceMessage(price: number | undefined, bounds: CreatorBoxPriceBounds) {
  if (price === undefined) return 'Set a price';
  if (bounds.max >= bounds.min && price > bounds.max)
    return `The price is at most ${bounds.max}, ${
      bounds.max === bounds.average
        ? 'what the average box gives back'
        : `${CREATOR_BOX_WORST_DRAW_MULTIPLE} times your cheapest item`
    }`;
  return creatorBoxPriceProblem(price, bounds);
}
