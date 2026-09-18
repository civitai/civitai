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
 * For the read paths that hand `meta` to the client as-is rather than through a
 * whitelist. Those clients read `meta.purchases`, so the row count has to land
 * on that key or they keep the drifting counter while the sanitized paths move
 * — the same `<ShopItem>` renders both, and it would show two different numbers
 * for one item depending on which page you reached it from.
 */
export const withSoldCount = <T extends { meta: unknown; _count: { purchases: number } }>(
  item: T
) => ({
  ...item,
  meta: { ...((item.meta ?? {}) as Record<string, unknown>), purchases: item._count.purchases },
});
