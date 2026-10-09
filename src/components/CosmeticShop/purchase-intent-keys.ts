import { create } from 'zustand';
import { purchaseCanBeRetriedFresh } from '~/components/Sticker/sticker.util';
import { PURCHASE_ALREADY_COMPLETED_MESSAGE } from '~/shared/constants/cosmetic-shop.constants';
import { mintPurchaseKey } from '~/utils/purchase-key';

/** The server's answer when this key's purchase was already granted. */
export function isPurchaseAlreadyCompleted(error: unknown): boolean {
  return (error as { message?: unknown } | null)?.message === PURCHASE_ALREADY_COMPLETED_MESSAGE;
}

type PurchaseIntentKeyStore = {
  keys: Record<number, string>;
  keyFor: (shopItemId: number) => string;
  release: (shopItemId: number, key: string) => void;
};

/**
 * One idempotency key per purchase intent, per shop item, for the browser
 * session. A store rather than component state: closing the purchase modal while
 * a request is unanswered and reopening it is the same intent, and a fresh key
 * there would charge again.
 */
export const usePurchaseIntentKeyStore = create<PurchaseIntentKeyStore>((set, get) => ({
  keys: {},
  keyFor: (shopItemId) => {
    const existing = get().keys[shopItemId];
    if (existing) return existing;
    const key = mintPurchaseKey();
    set((state) => ({ keys: { ...state.keys, [shopItemId]: key } }));
    return key;
  },
  // Only the key this attempt used: a newer intent may already hold the slot.
  release: (shopItemId, key) =>
    set((state) => {
      if (state.keys[shopItemId] !== key) return state;
      const { [shopItemId]: _released, ...rest } = state.keys;
      return { keys: rest };
    }),
}));

/**
 * Sends a purchase under the item's intent key. The key is released when the
 * intent ends: on success, when the purchase was already completed under it, or
 * when the server declined (a 4xx: nothing was charged). Any other failure may
 * have charged, so the key is held and the next press is the same intent.
 *
 * A caller that brings its own key keeps full control of it.
 */
export async function withPurchaseIntentKey<T>(
  shopItemId: number,
  givenKey: string | undefined,
  send: (idempotencyKey: string) => Promise<T>
): Promise<T> {
  if (givenKey) return send(givenKey);

  const { keyFor, release } = usePurchaseIntentKeyStore.getState();
  const key = keyFor(shopItemId);
  try {
    const result = await send(key);
    release(shopItemId, key);
    return result;
  } catch (error) {
    // Includes "already completed", which is a 400.
    if (purchaseCanBeRetriedFresh(error)) release(shopItemId, key);
    throw error;
  }
}
