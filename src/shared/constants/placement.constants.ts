import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzPurchaseTypes } from '~/shared/constants/buzz.constants';

/**
 * Placements are payable in paid Buzz only.
 *
 * Blue Buzz is not transferable by design, so a placement that took Blue and
 * paid the owner Blue would become a transfer mechanism — a farm could funnel it
 * from many accounts into one. The restriction closes that outright, where a
 * creator-score floor would only have raised its cost.
 *
 * Derived rather than hand-listed so it cannot drift from what the platform
 * actually treats as purchasable. `placement-currency.test.ts` pins the meaning
 * of the derivation, since `purchasable` is a UX flag that could be flipped.
 */
export const PLACEMENT_SPEND_TYPES = buzzPurchaseTypes as BuzzSpendType[];

export const isPlacementSpendType = (type: string): type is BuzzSpendType =>
  (PLACEMENT_SPEND_TYPES as string[]).includes(type);
