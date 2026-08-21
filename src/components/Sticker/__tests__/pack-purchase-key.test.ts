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

/**
 * 🔴 WHICH FAILURES RELEASE THE KEY.
 *
 * Releasing it after a refusal is right — the attempt is over and the next press
 * is a new intent. Releasing it after a TIMEOUT is how one purchase becomes two:
 * the charge may well have gone through, and a fresh key makes the retry a
 * second, separate purchase. So the default is to hold.
 */
describe('classifying a failed purchase', () => {
  it('releases on refusals the server states', async () => {
    const { purchaseDefinitelyDidNotCharge } = await import('~/components/Sticker/sticker.util');

    for (const message of [
      'Insufficient funds',
      'This purchase has already been completed',
      'That price has changed',
      'You already own this cosmetic',
    ])
      expect(purchaseDefinitelyDidNotCharge(new Error(message))).toBe(true);
  });

  it('holds the key on anything it cannot read as a refusal', async () => {
    const { purchaseDefinitelyDidNotCharge } = await import('~/components/Sticker/sticker.util');

    for (const error of [
      new Error('fetch failed'),
      new Error('The operation timed out'),
      new Error('Internal server error'),
      new Error(''),
      undefined,
      { message: 'insufficient' },
    ])
      expect(purchaseDefinitelyDidNotCharge(error)).toBe(false);
  });
});
