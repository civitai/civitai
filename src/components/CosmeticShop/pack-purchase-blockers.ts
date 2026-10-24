import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';

type PackDetail = RouterOutput['creatorShop']['getPack'];

/**
 * Every server-side pack refusal the Buy button mirrors, so it never renders
 * priced and enabled for a purchase the server will refuse.
 */
export const getPackPurchaseBlockers = (
  pack: Pick<
    PackDetail,
    'unavailableCount' | 'amountDue' | 'listed' | 'status' | 'availableQuantity' | 'isPackCreator'
  > & { meta: Pick<PackDetail['meta'], 'purchases'> }
) => {
  const unavailable = pack.unavailableCount > 0;
  // The server refuses a purchase that costs nothing — a free pack is
  // repeatable, and each one stacks another consumable balance.
  const nothingLeftToBuy = pack.amountDue <= 0;
  // The card that opened the modal can be stale: delisted, withdrawn or sold out
  // since it rendered.
  const offSale = !pack.listed || pack.status !== CosmeticShopItemStatus.Published;
  const soldOut =
    pack.availableQuantity !== null && (pack.meta.purchases ?? 0) >= pack.availableQuantity;
  const isOwnPack = pack.isPackCreator;
  return {
    unavailable,
    nothingLeftToBuy,
    offSale,
    soldOut,
    isOwnPack,
    blocked: unavailable || nothingLeftToBuy || offSale || soldOut || isOwnPack,
  };
};
