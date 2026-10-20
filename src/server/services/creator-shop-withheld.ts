import { dbRead } from '~/server/db/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { isListingDisplayable } from '~/server/services/creator-shop.data';
import { CosmeticFlag } from '~/shared/constants/cosmetic-flags.constants';
import { Flags } from '~/shared/utils/flags';

export const WITHHELD_COSMETIC_ERROR = 'This item is in review and cannot be equipped';

/**
 * The creator-made cosmetics among `cosmeticIds` that no holder may show: their creator's own
 * listing is not displayable, or was deleted while it was not (`CosmeticFlag.Withheld`). Other
 * creators' cross-listings don't count either way.
 */
export async function getWithheldCosmeticIds(cosmeticIds: number[], db = dbRead) {
  const withheld = new Set<number>();
  if (!cosmeticIds.length) return withheld;

  const listings = await db.cosmeticShopItem.findMany({
    where: { cosmeticId: { in: [...new Set(cosmeticIds)] } },
    select: {
      cosmeticId: true,
      addedById: true,
      status: true,
      meta: true,
      rejectionReason: true,
      cosmetic: { select: { createdById: true } },
    },
  });

  const displayable = new Set<number>();
  for (const { cosmeticId, addedById, cosmetic, status, meta, rejectionReason } of listings) {
    if (cosmeticId == null || cosmetic?.createdById == null || addedById !== cosmetic.createdById)
      continue;
    const shown = isListingDisplayable({
      status,
      meta: meta as CosmeticShopItemMeta | null,
      rejectionReason,
    });
    (shown ? displayable : withheld).add(cosmeticId);
  }
  for (const id of displayable) withheld.delete(id);

  const unlisted = [...new Set(cosmeticIds)].filter(
    (id) => !displayable.has(id) && !withheld.has(id)
  );
  if (unlisted.length) {
    const tombstoned = await db.cosmetic.findMany({
      where: { id: { in: unlisted }, createdById: { not: null } },
      select: { id: true, flags: true },
    });
    for (const { id, flags } of tombstoned)
      if (Flags.hasFlag(flags, CosmeticFlag.Withheld)) withheld.add(id);
  }
  return withheld;
}
