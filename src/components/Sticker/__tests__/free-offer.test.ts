import { describe, expect, it } from 'vitest';
import {
  FREE_REVIEW_CAVEAT,
  freeOfferFor,
  freeOptionLabel,
  freeRefusalMessage,
  isPlacingFree,
} from '~/components/Sticker/free-offer';

describe('the free option carries the mode', () => {
  it('says instant on an auto-accept space and needs review otherwise', () => {
    expect(freeOptionLabel(true)).toBe('Free · instant');
    expect(freeOptionLabel(false)).toBe('Free · needs review');
  });

  /**
   * The distinction is the whole reason the mode is on this option rather than on
   * the sticker button: a placer choosing between two offers needs to know which
   * one goes live now. A label that read the same either way would leave the mode
   * a hidden setting again.
   */
  it('reads differently in the two modes', () => {
    expect(freeOptionLabel(true)).not.toBe(freeOptionLabel(false));
  });

  it('states the asymmetry a decline creates', () => {
    // The image's slot comes back and the placer's day does not, which is the
    // one fact somebody might choose to pay to avoid.
    expect(FREE_REVIEW_CAVEAT).toMatch(/spent even if they decline/);
    expect(FREE_REVIEW_CAVEAT).toMatch(/allowance does not/);
  });
});

/**
 * The refusal copy, chosen from state re-read after the claim was refused rather
 * than from the server's own message.
 *
 * Ordered most specific first, so the most useful true thing wins. Each case
 * below is a distinct thing to tell somebody and a distinct thing to do next —
 * wait for midnight, pick a different image, or just pay — so collapsing any two
 * of them would send a person to the wrong remedy.
 */
describe('what a refused free claim says', () => {
  const HAS_SLOT = { freeSlots: 4, freeSlotsRemaining: 2 };
  const FULL = { freeSlots: 4, freeSlotsRemaining: 0 };
  const CLOSED = { freeSlots: 0, freeSlotsRemaining: 0 };
  const HAS_DAY = { remaining: 1, usedHere: false };

  it('names this image when the placer has already used one here', () => {
    expect(freeRefusalMessage({ remaining: 1, usedHere: true }, HAS_SLOT)).toMatch(
      /already used a free sticker on this image/
    );
  });

  it('names the reset when the day is spent', () => {
    expect(freeRefusalMessage({ remaining: 0, usedHere: false }, HAS_SLOT)).toMatch(/midnight UTC/);
  });

  it('names the race when the last slot went to somebody else', () => {
    expect(freeRefusalMessage(HAS_DAY, FULL)).toMatch(/took the last free slot/);
  });

  /**
   * `freeSlotsRemaining === 0` covers two different facts, and this is where the
   * two have to be told apart: the resolver short-circuits the reservation count
   * when there is no capacity, so a creator who takes no free stickers looks
   * identical to one whose slots are full unless `freeSlots` is read alongside.
   * Saying somebody beat them to it would be a lie about a slot that never
   * existed.
   */
  it('distinguishes a closed space from a full one', () => {
    const closed = freeRefusalMessage(HAS_DAY, CLOSED);

    expect(closed).toMatch(/not taking free stickers/);
    expect(closed).not.toBe(freeRefusalMessage(HAS_DAY, FULL));
  });

  /**
   * A block, a suspension, or the creator closing the space between the render
   * and the press. The re-read cannot explain those, and naming a cause we do
   * not have is worse than saying only what is certain.
   */
  it('says only what is certain when the re-read explains nothing', () => {
    expect(freeRefusalMessage(HAS_DAY, HAS_SLOT)).toBe('That free slot could not be claimed.');
    expect(freeRefusalMessage()).toBe('That free slot could not be claimed.');
  });

  it('never quotes the server, which is free to reword its refusals', () => {
    const every = [
      freeRefusalMessage({ remaining: 1, usedHere: true }, HAS_SLOT),
      freeRefusalMessage({ remaining: 0, usedHere: false }, HAS_SLOT),
      freeRefusalMessage(HAS_DAY, FULL),
      freeRefusalMessage(HAS_DAY, CLOSED),
      freeRefusalMessage(HAS_DAY, HAS_SLOT),
    ];

    // The service prefixes every placement refusal this way. A message carrying
    // it would mean the client had started parsing prose instead.
    for (const message of every) expect(message).not.toContain('placement:');
  });
});

/**
 * Whether the free offer is on the table at all.
 *
 * Three separate facts, each a different reason to be looking at the paid
 * button, so each is checked on its own — a predicate that dropped one would
 * offer something the claim then refuses, and the placer would meet a refusal
 * after choosing rather than an offer that was never there.
 */
describe('whether the free offer is available', () => {
  const OPEN = { mode: 'review', freeSlots: 4, freeSlotsRemaining: 2 };
  const HAS_DAY = { remaining: 1, usedHere: false };

  it('offers free when the creator has a slot and the placer has their day', () => {
    expect(freeOfferFor(OPEN, HAS_DAY)).toEqual({ instant: false });
  });

  it('carries the mode, which is what the option label needs', () => {
    expect(freeOfferFor({ ...OPEN, mode: 'auto' }, HAS_DAY)).toEqual({ instant: true });
  });

  it('withholds it when the creator has no slots left', () => {
    expect(freeOfferFor({ ...OPEN, freeSlotsRemaining: 0 }, HAS_DAY)).toBeNull();
  });

  it('withholds it when the placer has spent their day', () => {
    expect(freeOfferFor(OPEN, { remaining: 0, usedHere: false })).toBeNull();
  });

  it('withholds it when the placer has already placed free on this image', () => {
    expect(freeOfferFor(OPEN, { remaining: 1, usedHere: true })).toBeNull();
  });

  /**
   * Paid first while either answer is unknown. The other order shows a free
   * option and then removes it as the query lands, which is the one thing worse
   * than not offering it — somebody reads a free offer, reaches for it, and it
   * has become a charge.
   */
  it('withholds it until both answers have arrived', () => {
    expect(freeOfferFor(undefined, HAS_DAY)).toBeNull();
    expect(freeOfferFor(OPEN, undefined)).toBeNull();
    expect(freeOfferFor()).toBeNull();
  });
});

/**
 * Which offer is selected. The default is the whole decision here: free wherever
 * one is available, because the point of the free tier is that somebody tries
 * the feature without paying to find out whether they like it.
 */
describe('which offer is selected', () => {
  const OFFER = { instant: false };

  it('defaults to free whenever an offer is available', () => {
    expect(isPlacingFree(null, OFFER)).toBe(true);
  });

  it('defaults to paid when there is no free offer', () => {
    expect(isPlacingFree(null, null)).toBe(false);
  });

  it('respects an explicit choice of paid while free is still available', () => {
    // Paid placements never consume free slots, so choosing to pay when a free
    // slot exists is a real choice rather than a mistake to correct.
    expect(isPlacingFree('paid', OFFER)).toBe(false);
  });

  /**
   * The fallback after a lost slot race, and the reason the second argument wins
   * over the first: the control settles on paid by clearing the offer as well as
   * by setting the choice, and a stale `'free'` must not survive either.
   */
  it('never places free once the offer has gone, whatever was chosen', () => {
    expect(isPlacingFree('free', null)).toBe(false);
  });
});
