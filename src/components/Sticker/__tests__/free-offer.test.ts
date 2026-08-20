import { describe, expect, it } from 'vitest';
import {
  barFreeLabel,
  barTooltip,
  FREE_REVIEW_CAVEAT,
  freeOfferFor,
  freeOptionLabel,
  freeRefusalMessage,
  freeRefusalOutcome,
  isPlacingFree,
  preCommitFreeReason,
  SHARED_ALLOWANCE_NOTE,
  trayPriceLine,
  trayReviewLine,
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

  it('never quotes the server where it does speak, since prose may be reworded', () => {
    const spoken = [
      freeRefusalMessage({ remaining: 1, usedHere: true }, HAS_SLOT),
      freeRefusalMessage({ remaining: 0, usedHere: false }, HAS_SLOT),
      freeRefusalMessage(HAS_DAY, FULL),
      freeRefusalMessage(HAS_DAY, CLOSED),
    ];

    // Every rung answers, so a null here would mean a branch stopped firing and
    // the loop below went vacuous.
    expect(spoken.filter(Boolean)).toHaveLength(spoken.length);
    // The service prefixes every placement refusal this way. A message carrying
    // it would mean the client had started parsing prose instead.
    for (const message of spoken) expect(message).not.toContain('placement:');
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

/**
 * The ladder's ORDER, which no single-condition fixture can hold.
 *
 * More than one rung is true at once in ordinary use — a placer who spent their
 * day on a creator who has since closed their slots trips two — and the first
 * match is what gets said. A test that only ever sets one condition passes for
 * every permutation of the ladder, so the swap that turns a true sentence into a
 * false one is invisible to it.
 *
 * Each case below sets BOTH conditions of one adjacent pair and names the rung
 * that has to win. The rule is that a refusal which is permanent for this image
 * outranks one that lifts by itself: "your allowance comes back at midnight" is a
 * promise about tomorrow, and on an image whose creator takes no free stickers it
 * is simply false.
 */
describe('the refusal ladder is ordered, not merely complete', () => {
  const CLOSED = { freeSlots: 0, freeSlotsRemaining: 0 };
  const FULL = { freeSlots: 4, freeSlotsRemaining: 0 };
  const OPEN = { freeSlots: 4, freeSlotsRemaining: 2 };
  const SPENT = { remaining: 0, usedHere: false };
  const PLACED_HERE = { remaining: 1, usedHere: true };
  const BOTH_SPENT = { remaining: 0, usedHere: true };

  it.each([
    [
      'a closed space outranks having already placed here',
      CLOSED,
      PLACED_HERE,
      /not taking free stickers/,
    ],
    [
      'having already placed here outranks a spent day',
      OPEN,
      BOTH_SPENT,
      /already used a free sticker on this image/,
    ],
    ['a spent day outranks a full space', FULL, SPENT, /midnight UTC/],
  ])('%s', (_name, space, standing, expected) => {
    expect(freeRefusalMessage(standing, space)).toMatch(expected);
  });

  /**
   * The transitive case, stated separately because pairwise adjacency does not
   * imply it: every rung true at once still has to produce the permanent one.
   * This is the state a creator closing their slots leaves behind for somebody
   * who had already placed and already spent their day.
   */
  it('says the permanent thing when every rung is true', () => {
    expect(freeRefusalMessage(BOTH_SPENT, CLOSED)).toMatch(/not taking free stickers/);
  });

  /**
   * The specific false promise the order exists to prevent, asserted as an
   * absence as well as a presence — a reordering that produced some other true
   * sentence would still be caught by the pairs above, but this is the one that
   * sends somebody back tomorrow for nothing.
   */
  it('never promises a reset on an image that will never take a free sticker', () => {
    expect(freeRefusalMessage(SPENT, CLOSED)).not.toMatch(/midnight/);
  });
});

/**
 * What the ladder deliberately will NOT answer.
 *
 * A free placement is refused by everything the paid one is — a block, a
 * moderator suspension, self-placement, a sticker over the creator's size limit
 * — and each of those arrives with a message written for the person who hit it.
 * `null` is what tells the caller to show that message instead of inventing one,
 * and it is the difference between a wrong reason and a wrong remedy: offering
 * the paid button to somebody who is blocked fails the same way again.
 */
describe('the ladder stays silent where it does not know', () => {
  it('returns null when nothing about the free tier explains the refusal', () => {
    expect(
      freeRefusalMessage({ remaining: 1, usedHere: false }, { freeSlots: 4, freeSlotsRemaining: 2 })
    ).toBeNull();
  });

  it('returns null when the re-read itself did not arrive', () => {
    expect(freeRefusalMessage()).toBeNull();
    expect(freeRefusalMessage({ remaining: 1, usedHere: false })).toBeNull();
    expect(freeRefusalMessage(undefined, { freeSlots: 4, freeSlotsRemaining: 2 })).toBeNull();
  });
});

/**
 * What the refusal does, as distinct from what it says.
 *
 * `fallBackToPaid` is the consequential half. A control that settles on paid is
 * telling somebody the problem was money — right when the free slots ran out,
 * and wrong when the placement itself was refused, because the paid button then
 * fails the same way and they have been sent to a remedy that cannot work.
 */
describe('what a refused free claim does next', () => {
  const SERVER = 'placement: you cannot place a sticker on your own content';

  it('falls back to paid, with its own wording, where free specifically ran out', () => {
    const outcome = freeRefusalOutcome(
      'Someone took the last free slot on this image first.',
      SERVER
    );

    expect(outcome.fallBackToPaid).toBe(true);
    expect(outcome.message).toMatch(/last free slot/);
    // Not the server's prose, which does not say which rule stopped it.
    expect(outcome.message).not.toContain('placement:');
  });

  /**
   * The defect this shape exists to avoid: a refusal that has nothing to do with
   * the free tier arrives with a message somebody wrote for exactly this moment,
   * and reporting it as a lost race discards that message AND offers a button
   * that will fail identically.
   */
  it('keeps the server message and does not offer paid where the placement was refused', () => {
    const outcome = freeRefusalOutcome(null, SERVER);

    expect(outcome.fallBackToPaid).toBe(false);
    expect(outcome.message).toBe(SERVER);
    expect(outcome.message).not.toMatch(/free slot/);
  });

  it('titles the two cases differently, since one is about price and one is not', () => {
    expect(freeRefusalOutcome('anything', SERVER).title).not.toBe(
      freeRefusalOutcome(null, SERVER).title
    );
  });
});

/**
 * The tray's two sentences, here rather than in the component because inline
 * neither ternary was observable: dropping either one turns nothing red and
 * produces the exact contradiction the lines exist to prevent.
 */
describe('the tray states both offers when both are open', () => {
  it('names free and the price together, with the use as the constant', () => {
    const both = trayPriceLine(true, 700);

    expect(both).toMatch(/Free/);
    expect(both).toMatch(/700 Buzz/);
    // Free of the creator's price and of nothing else. Without this the tray and
    // the Place button disagree about what a sticker costs.
    expect(both).toMatch(/one use either way/);
  });

  it('names only the price when free is not on offer', () => {
    const paid = trayPriceLine(false, 700);

    expect(paid).toBe('700 Buzz + one use');
    expect(paid).not.toMatch(/[Ff]ree/);
  });

  /**
   * 🔴 The free half is `FREE_REVIEW_CAVEAT` itself, not a paraphrase. Three
   * places in the product state what a decline costs a free placer — this, the
   * caveat under the draft's own free option, and `declineConsequence` on the
   * owner's side — and two of the three now come from one constant.
   */
  it('reuses the owned caveat rather than restating it', () => {
    expect(trayReviewLine(true)).toContain(FREE_REVIEW_CAVEAT);
  });

  it('keeps the paid fee disclosure in both branches', () => {
    // Where both offers are open, somebody choosing to pay still needs it.
    for (const freeAvailable of [true, false])
      expect(trayReviewLine(freeAvailable)).toMatch(/part of what you paid/);
  });

  it('says nothing about an allowance when free is not on offer', () => {
    expect(trayReviewLine(false)).not.toMatch(/allowance/);
  });
});

/**
 * When the allowance comes back, taken from the value the server computed rather
 * than from a boundary written down twice.
 */
describe('the reset the refusal names', () => {
  const spent = { remaining: 0, usedHere: false };
  const open = { freeSlots: 4, freeSlotsRemaining: 2 };

  it('uses the reset the server shipped', () => {
    expect(
      freeRefusalMessage({ ...spent, resetsAt: new Date('2026-08-18T00:00:00Z') }, open)
    ).toMatch(/comes back at 00:00 UTC/);
  });

  /**
   * The point of deriving it: the day boundary is the server's rule, so a
   * different one has to change this sentence rather than leave it wrong.
   */
  it('follows a reset that is not midnight', () => {
    expect(
      freeRefusalMessage({ ...spent, resetsAt: new Date('2026-08-18T06:30:00Z') }, open)
    ).toMatch(/comes back at 06:30 UTC/);
  });

  it('still says when it lifts if the reset never arrived', () => {
    expect(freeRefusalMessage(spent, open)).toMatch(/comes back at midnight UTC/);
    expect(freeRefusalMessage({ ...spent, resetsAt: 'not a date' }, open)).toMatch(
      /comes back at midnight UTC/
    );
  });
});

/**
 * The reaction bar, which is where this whole thing went wrong.
 *
 * The bar renders per feed card and used to print the creator's capacity —
 * `N of M free` — in a place every reader takes as an offer to themselves. Two
 * people reported the same thing within a day of launch: the label said free,
 * the placement cost Buzz.
 *
 * These sit here rather than in the component for the reason the rest of this
 * file does: the branches are the product decision, and a component test that
 * renders one of them proves nothing about the other three.
 */
describe('the bar offers free only where the reader can take it', () => {
  const SLOTS_OPEN = { freeSlots: 4, freeSlotsRemaining: 2 };
  const SLOTS_HELD = { freeSlots: 4, freeSlotsRemaining: 0 };
  const NO_FREE = { freeSlots: 0, freeSlotsRemaining: 0 };

  it('labels the smaller of the two scarcities', () => {
    // The creator has two going spare; the reader may take one. Quoting the
    // creator's number here is the original defect.
    expect(barFreeLabel(SLOTS_OPEN, 1)).toBe('1 free');
    // And the other way round: a reader with allowance to spare is still bounded
    // by the image.
    expect(barFreeLabel({ freeSlots: 4, freeSlotsRemaining: 1 }, 3)).toBe('1 free');
  });

  it.each([
    ['the viewer has spent their day', SLOTS_OPEN, 0],
    ['the creator takes no free placements', NO_FREE, 1],
    ['every slot on the image is held', SLOTS_HELD, 1],
  ])('says nothing when %s', (_name, space, remaining) => {
    expect(barFreeLabel(space, remaining)).toBeNull();
  });

  /**
   * 🔴 `undefined` is not zero.
   *
   * In flight, the honest render is no label at all. Treating it as zero shows
   * the paid state and then adds "free" a beat later on every card in the feed;
   * treating it as one promises something that may not exist. Absent becomes
   * present quietly, which is the only transition that costs the reader nothing.
   */
  it('claims nothing while the allowance is still loading', () => {
    expect(barFreeLabel(SLOTS_OPEN, undefined)).toBeNull();
    expect(barFreeLabel(undefined, 1)).toBeNull();
  });
});

describe('the bar tooltip names the price, and the reason when there is one', () => {
  const SLOTS_OPEN = { freeSlots: 4, freeSlotsRemaining: 2 };
  const SLOTS_HELD = { freeSlots: 4, freeSlotsRemaining: 0 };
  const NO_FREE = { freeSlots: 0, freeSlotsRemaining: 0 };
  const RESETS = new Date('2026-08-21T00:00:00.000Z');

  /**
   * The price in every branch. That rule predates this change — it is what kept
   * the old label from being an outright lie about cost — and the reason is an
   * addition to it, never a replacement.
   */
  it.each([
    ['free on offer', SLOTS_OPEN, 1],
    ['a spent allowance', SLOTS_OPEN, 0],
    ['slots all held', SLOTS_HELD, 1],
    ['a creator who takes none', NO_FREE, 1],
  ])('quotes the price with %s', (_name, space, remaining) => {
    expect(
      barTooltip({ price: 100, space, allowanceRemaining: remaining, resetsAt: RESETS })
    ).toMatch(/100 Buzz/);
  });

  it('explains a spent allowance and names what it is shared with', () => {
    const tip = barTooltip({
      price: 100,
      space: SLOTS_OPEN,
      allowanceRemaining: 0,
      resetsAt: RESETS,
    });

    expect(tip).toMatch(/used today's free placement/);
    // The second ticket, in the sentence that needs it most: this reader's
    // allowance may well have gone on a remix gallery, and without this the
    // sticker surface has no explanation for where it went.
    expect(tip).toMatch(new RegExp(SHARED_ALLOWANCE_NOTE));
    // Read off the server's own reset rather than restating the boundary.
    expect(tip).toMatch(/00:00 UTC/);
  });

  /**
   * The two zeroes that look alike. `freeSlotsRemaining === 0` is both "takes no
   * free placements" and "all currently held", and only `freeSlots` separates
   * them — the first has nothing to say, the second says something worth acting
   * on, because a decline returns the slot.
   */
  it('tells a held slot apart from a creator who takes none', () => {
    const held = barTooltip({ price: 100, space: SLOTS_HELD, allowanceRemaining: 1 });
    const none = barTooltip({ price: 100, space: NO_FREE, allowanceRemaining: 1 });

    expect(held).toMatch(/comes back if the creator declines/);
    expect(none).toBe('Place a sticker · 100 Buzz');
  });

  it('offers both prices when free is genuinely available', () => {
    const tip = barTooltip({ price: 100, space: SLOTS_OPEN, allowanceRemaining: 1 });

    expect(tip).toMatch(/free, or 100 Buzz/);
    expect(tip).toMatch(new RegExp(SHARED_ALLOWANCE_NOTE));
  });

  /**
   * Loading is not "spent". A tooltip asserting a reset time from a defaulted
   * zero tells a reader with a free placement in hand that they have none — for
   * as long as the query takes, on every card.
   */
  it('promises and refuses nothing while the allowance is unknown', () => {
    const tip = barTooltip({ price: 100, space: SLOTS_OPEN, allowanceRemaining: undefined });

    expect(tip).toBe('Place a sticker · 100 Buzz');
  });
});

/**
 * The tray's pre-commit reason.
 *
 * The strings were always there; what was missing was a caller that ran BEFORE
 * the placement. This gate is the caller, and its two silences are as much the
 * product decision as the sentences are.
 */
describe('the tray says why free is unavailable before anything is committed', () => {
  const HAS_SLOT = { freeSlots: 4, freeSlotsRemaining: 2 };
  const NO_FREE = { freeSlots: 0, freeSlotsRemaining: 0 };
  const SPENT = { remaining: 0, usedHere: false };
  const READY = { remaining: 1, usedHere: false };
  const USED_HERE = { remaining: 1, usedHere: true };

  it('explains a spent allowance while both offers are still on screen', () => {
    expect(preCommitFreeReason(false, SPENT, HAS_SLOT)).toMatch(/used today's free placement/);
  });

  it('explains a free placement already used on this image', () => {
    // Once ever, not once per day — so this one does not lift at midnight, and
    // saying it does would send someone back tomorrow to the same refusal.
    expect(preCommitFreeReason(false, USED_HERE, HAS_SLOT)).toMatch(/already used a free sticker/);
  });

  /**
   * 🔴 Silence is the correct output here, and it is the half a test is most
   * likely to skip.
   */
  it('says nothing when free is on offer', () => {
    expect(preCommitFreeReason(true, READY, HAS_SLOT)).toBeNull();
  });

  it('says nothing on an image whose creator never offered free', () => {
    // True of most of the site. Narrating it on every ordinary paid image turns
    // a limit nobody was promised into a notice everybody reads.
    expect(preCommitFreeReason(false, SPENT, NO_FREE)).toBeNull();
  });

  it('says nothing until both facts have arrived', () => {
    expect(preCommitFreeReason(false, undefined, HAS_SLOT)).toBeNull();
    expect(preCommitFreeReason(false, SPENT, undefined)).toBeNull();
  });
});
