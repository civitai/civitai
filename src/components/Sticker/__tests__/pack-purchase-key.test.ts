import { beforeEach, describe, expect, it } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import { purchaseCanBeRetriedFresh } from '~/components/Sticker/sticker.util';
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
 * Releasing after a refusal is right — the attempt is over and the next press is
 * a new intent. Releasing after a TIMEOUT is how one purchase becomes two: the
 * charge may well have gone through, and a fresh key makes the retry a second,
 * separate purchase.
 *
 * ⚠️ THE FIRST VERSION OF THIS TEST PASSED AGAINST INVENTED SERVER MESSAGES. It
 * matched a hand-written list of refusal wordings, and the fixtures were written
 * to match the list rather than to match the server — so it certified a
 * classifier that missed seven of the ten real refusals, including the
 * re-priced-listing case it was supposed to be for. The rule is structural now,
 * and these fixtures are tRPC error shapes rather than sentences.
 */
const trpcError = (httpStatus: number) => ({ data: { httpStatus } });

describe('classifying a failed purchase', () => {
  it('releases on anything the server declined', async () => {
    // 400 covers every refusal in the purchase path now that they are TRPCErrors;
    // the others are here because the rule is the class, not the number.
    for (const status of [400, 401, 403, 404, 409, 422])
      expect(purchaseCanBeRetriedFresh(trpcError(status))).toBe(true);
  });

  /**
   * Everything that might have charged. A network failure has no `data` at all,
   * which is exactly the case the old string matching could not see.
   */
  it('holds the key on anything that might have gone through', async () => {
    for (const error of [
      trpcError(500),
      trpcError(502),
      trpcError(504),
      new Error('Failed to fetch'),
      new Error('The operation timed out'),
      {},
      null,
      undefined,
    ])
      expect(purchaseCanBeRetriedFresh(error)).toBe(false);
  });
});
