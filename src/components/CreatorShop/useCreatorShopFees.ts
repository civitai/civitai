import { trpc } from '~/utils/trpc';

export const FEE_UNAVAILABLE_MESSAGE =
  "We couldn't load the submission fee. Close and reopen this form to try again.";

/**
 * Operator-tunable submission fees, from the same read the charge uses.
 *
 * Deliberately no `placeholderData` fallback: the fee is charged before review and is
 * not refunded, so a quoted default that the server then disagrees with takes real
 * money. `undefined` means "not known yet" and callers block submit on it.
 */
export function useCreatorShopFees() {
  const { data } = trpc.creatorShop.getFees.useQuery(undefined, {
    staleTime: 3 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  return data;
}
