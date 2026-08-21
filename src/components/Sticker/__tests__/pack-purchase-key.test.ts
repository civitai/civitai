import { beforeEach, describe, expect, it } from 'vitest';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

/**
 * The idempotency key a pack purchase is charged under.
 *
 * 🔴 THIS IS THE ONE WHOSE FAILURE MODE IS CHARGING SOMEONE TWICE, and it had no
 * test at all until a review said so. A pack grants the STICKER — `markPurchased`
 * then frees every draft of it — so two copies of one sticker showing two buy
 * buttons are one buying intent wearing two faces. Minted per draft, pressing
 * both inside a second was two keys and two charges for something you get once.
 * Duplicating put those two buttons a click apart.
 */
const store = () => useStickerPlacementDraftStore.getState();

describe('the pack purchase key', () => {
  beforeEach(() => {
    store().close();
    store().open(1);
  });

  it('is the same key for the same sticker, which is the whole point', () => {
    expect(store().packPurchaseKey(42)).toBe(store().packPurchaseKey(42));
  });

  it('is a different key for a different sticker', () => {
    expect(store().packPurchaseKey(42)).not.toBe(store().packPurchaseKey(43));
  });

  /**
   * Two sessions are two intents: someone who buys a pack, spends it, and comes
   * back later to buy the same pack again must not be refused as a duplicate.
   */
  it('is forgotten when the session ends', () => {
    const first = store().packPurchaseKey(42);
    store().close();
    store().open(1);

    expect(store().packPurchaseKey(42)).not.toBe(first);
  });

  /**
   * But NOT forgotten by re-opening the same image mid-session — the tray can be
   * put away and brought back with drafts alive, and that is one intent still.
   */
  it('survives re-opening the image it was minted on', () => {
    const first = store().packPurchaseKey(42);
    store().open(1);

    expect(store().packPurchaseKey(42)).toBe(first);
  });

  /**
   * A failed purchase ends the attempt. Reusing its key would have a server that
   * records failed keys refuse every later attempt this session, locking the
   * placer out of a sticker they are trying to buy.
   */
  it('mints a new key after a failure clears the old one', () => {
    const first = store().packPurchaseKey(42);
    store().clearPackPurchaseKey(42);

    expect(store().packPurchaseKey(42)).not.toBe(first);
  });

  it('clearing one sticker leaves the others alone', () => {
    const other = store().packPurchaseKey(43);
    store().packPurchaseKey(42);
    store().clearPackPurchaseKey(42);

    expect(store().packPurchaseKey(43)).toBe(other);
  });
});
