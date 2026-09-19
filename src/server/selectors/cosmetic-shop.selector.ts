import { Prisma } from '@prisma/client';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const cosmeticShopItemSelect = Prisma.validator<Prisma.CosmeticShopItemSelect>()({
  id: true,
  unitAmount: true,
  availableFrom: true,
  availableTo: true,
  availableQuantity: true,
  title: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  cosmetic: {
    // creator = attribution for creator-made cosmetics featured in official
    // sections (null for official cosmetics).
    select: {
      ...simpleCosmeticSelect,
      videoUrl: true,
      creator: { select: userWithCosmeticsSelect },
    },
  },
  cosmeticId: true,
  addedById: true,
  // A pack has no cosmetic, so cards attribute it to its lister instead.
  addedBy: { select: userWithCosmeticsSelect },
  meta: true,
  // How many actually sold. `meta.purchases` is a denormalised counter that
  // drifts — it is bumped outside the purchase transaction, so concurrent buys
  // lose increments and a rolled-back buy keeps one. The sold-out gate and the
  // MostPopular sort have always counted rows; this is what lets the displayed
  // number agree with them.
  _count: { select: { purchases: true } },
});

/**
 * For the editor reads, which hand back the whole `meta` rather than the display
 * list. They read `meta.purchases`, so the row count has to land on that key or
 * an editor shows the drifting counter while every buyer surface shows rows.
 */
export const withSoldCount = <T extends { meta: unknown; _count: { purchases: number } }>(
  item: T
) => ({
  ...item,
  meta: { ...((item.meta ?? {}) as Record<string, unknown>), purchases: item._count.purchases },
});
