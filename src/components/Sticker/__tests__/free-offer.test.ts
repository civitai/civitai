import { describe, expect, it } from 'vitest';
import {
  FREE_PLACEMENTS_PER_DAY,
  FREE_SLOT_TAKEN_NOTE,
  PLACEMENT_SURFACES,
  SHARED_ALLOWANCE_NOTE,
} from '~/shared/utils/placement';
import {
  barFreeLabel,
  FREE_REVIEW_CAVEAT,
  freeOfferFor,
  freeHintText,
  freeOptionLabel,
  freeRefusalMessage,
  freeRefusalOutcome,
  isPlacingFree,
  preCommitFreeReason,
  trayNotes,
} from '~/components/Sticker/free-offer';

describe('the free option is a price, not a process', () => {
  /**
   * 🔴 It used to read `Free · instant` / `Free · needs review` beside a plain
   * `100 Buzz`. Justin, on seeing it: "it makes it seem like the other one's not
   * going to need review". Both options go to the creator on a review space and
   * both are live at once on an auto one — the mode was never a property of the
   * FREE option, it is a property of the space, and putting it on one of two
   * segments made it read as the difference between them.
   */
  it('says nothing about review, on either kind of space', () => {
    expect(freeOptionLabel()).toBe('Free');
  });
});

/**
 * What a decline costs the placer, which is the one line under the button.
 */
describe('the caveat says what pressing spends', () => {
  it('names the spend and the decline in one clause', () => {
    // Shrunk from two sentences about the asymmetry between the creator's slot
    // and the placer's day. The fact that has to land is that pressing spends
    // it, and that a decline does not give it back.
    expect(FREE_REVIEW_CAVEAT).toMatch(/Spends your free placement/);
    expect(FREE_REVIEW_CAVEAT).toMatch(/even if they decline/);
    // Short enough to sit in a chip under the button rather than as a paragraph
    // above it — the shape Justin asked for.
    expect(FREE_REVIEW_CAVEAT.length).toBeLessThan(70);
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

  /**
   * The sentence no longer names WHEN. The reset is a live countdown beside it
   * now — a phrase like "comes back at midnight UTC" is still sitting there at
   * 23:59 saying nothing useful, and Justin asked for the time remaining
   * instead. What this still has to say is WHICH refusal it is.
   */
  it('says the day is spent, without dating it', () => {
    const message = freeRefusalMessage({ remaining: 0, usedHere: false }, HAS_SLOT);

    expect(message).toMatch(/used today's free placement/);
    expect(message).not.toMatch(/UTC|comes back/);
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
    ['a spent day outranks a full space', FULL, SPENT, /used today's free placement/],
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
 * The tray's lines.
 *
 * They were one sentence, concatenated with ` · ` separators, spanning the full
 * width of the panel — and at that width nobody read to the end. They are now
 * one short line each, and the coupling went with the prose: no fragment has to
 * know whether another will be appended after it, which is what made a full stop
 * in one of them render a separator mid-sentence.
 */
describe('the tray says its piece in short lines', () => {
  const texts = (notes: ReturnType<typeof trayNotes>) => notes.map((note) => note.text).join(' | ');

  it('names free and the price together when both are open', () => {
    const notes = trayNotes({ freeAvailable: true, price: 700, review: false });

    expect(texts(notes)).toMatch(/Free, or 700 Buzz/);
    // Free of the creator's price and of nothing else. Without this the tray and
    // the Place button disagree about what a sticker costs.
    expect(texts(notes)).toMatch(/one use either way/);
  });

  it('names only the price when free is not on offer', () => {
    const notes = trayNotes({ freeAvailable: false, price: 700, review: false });

    expect(texts(notes)).toBe('700 Buzz + one use');
    expect(texts(notes)).not.toMatch(/[Ff]ree/);
  });

  it('names the shared budget only where there is a free one to spend', () => {
    // Case-insensitive: the line capitalises the clause, because on a row of
    // its own it starts the sentence rather than continuing one.
    expect(texts(trayNotes({ freeAvailable: true, price: 700, review: false }))).toMatch(
      new RegExp(SHARED_ALLOWANCE_NOTE, 'i')
    );
    // Explaining a limit to somebody who has nothing to spend against it is
    // noise about a thing they did not ask for.
    expect(texts(trayNotes({ freeAvailable: false, price: 700, review: false }))).not.toMatch(
      new RegExp(SHARED_ALLOWANCE_NOTE, 'i')
    );
  });

  /**
   * 🔴 The free half is `FREE_REVIEW_CAVEAT` itself, not a paraphrase. Three
   * places in the product state what a decline costs a free placer — this, the
   * line under the draft's own Place button, and `declineConsequence` on the
   * owner's side — and two of the three come from one constant.
   */
  it('reuses the owned caveat rather than restating it', () => {
    expect(texts(trayNotes({ freeAvailable: true, price: 700, review: true }))).toContain(
      FREE_REVIEW_CAVEAT
    );
  });

  it('keeps the paid fee disclosure where the space reviews', () => {
    expect(texts(trayNotes({ freeAvailable: false, price: 700, review: true }))).toMatch(
      /part of what you paid/
    );
  });

  it('says nothing about review on a space that does not review', () => {
    const notes = trayNotes({ freeAvailable: true, price: 700, review: false });

    expect(texts(notes)).not.toMatch(/approves/);
    expect(texts(notes)).not.toMatch(/decline/);
  });

  /**
   * The reason is last and warns, because it is the only line about the READER
   * rather than about the placement — and it is the one they are looking for
   * when free is not on offer.
   */
  it('puts the refusal last, and marks it', () => {
    const notes = trayNotes({
      freeAvailable: false,
      price: 700,
      review: true,
      reason: 'You have already used a free sticker on this image.',
    });

    expect(notes[notes.length - 1]).toEqual({
      id: 'reason',
      tone: 'warn',
      text: 'You have already used a free sticker on this image.',
    });
  });

  it('adds no line at all when there is no reason to give', () => {
    expect(
      trayNotes({ freeAvailable: true, price: 700, review: true, reason: null }).some(
        (note) => note.id === 'reason'
      )
    ).toBe(false);
  });

  /**
   * Every line is its own row, so none of them can end up inside another. This
   * is what the ` · ` concatenation could not promise.
   */
  it('keeps each line separate and short', () => {
    for (const note of trayNotes({ freeAvailable: true, price: 700, review: true }))
      expect(note.text.length).toBeLessThan(60);
  });
});

/**
 * The reaction bar, which is where this whole thing went wrong.
 *
 * The bar printed the creator's capacity — `N of M free` — in a place every
 * reader takes as an offer to themselves. Two people reported the same thing
 * within a day of launch: the label said free, the placement cost Buzz.
 *
 * These sit here rather than in the component for the reason the rest of this
 * file does: the branches are the product decision, and a component test that
 * renders one of them proves nothing about the other four.
 */
describe('the bar offers free only where the reader can take it', () => {
  const SLOTS_OPEN = { freeSlots: 4, freeSlotsRemaining: 2 };
  const SLOTS_HELD = { freeSlots: 4, freeSlotsRemaining: 0 };
  const NO_FREE = { freeSlots: 0, freeSlotsRemaining: 0 };
  const READY = { remaining: 1, usedHere: false };

  it('labels the smaller of the two counts', () => {
    // The creator has two going spare; the reader may take one. Quoting the
    // creator's number here is the original defect.
    expect(barFreeLabel(SLOTS_OPEN, READY)).toBe('1 free');
    // And the other way round: a reader with allowance to spare is still bounded
    // by the image.
    expect(
      barFreeLabel({ freeSlots: 4, freeSlotsRemaining: 1 }, { remaining: 3, usedHere: false })
    ).toBe('1 free');
  });

  it.each([
    ['the viewer has spent their day', SLOTS_OPEN, { remaining: 0, usedHere: false }],
    ['they already used a free one here', SLOTS_OPEN, { remaining: 1, usedHere: true }],
    ['the creator takes no free placements', NO_FREE, READY],
    ['every slot on the image is held', SLOTS_HELD, READY],
  ])('says nothing when %s', (_name, space, standing) => {
    expect(barFreeLabel(space, standing)).toBeNull();
  });

  /**
   * 🔴 `undefined` is not "no allowance".
   *
   * In flight, the honest render is no label at all. Treating it as spent shows
   * the paid state and then adds "free" a beat later; treating it as available
   * promises something that may not exist. Absent becomes present quietly, which
   * is the only transition that costs the reader nothing.
   */
  it('claims nothing while the standing is still loading', () => {
    expect(barFreeLabel(SLOTS_OPEN, undefined)).toBeNull();
    expect(barFreeLabel(undefined, READY)).toBeNull();
  });
});

describe('the free hint is shown only where there is something to take', () => {
  const SLOTS_OPEN = { freeSlots: 4, freeSlotsRemaining: 2 };
  const SLOTS_HELD = { freeSlots: 4, freeSlotsRemaining: 0 };
  const NO_FREE = { freeSlots: 0, freeSlotsRemaining: 0 };
  const RESETS = new Date('2026-08-21T00:00:00.000Z');
  const READY = { remaining: 1, usedHere: false, resetsAt: RESETS };
  const SPENT = { remaining: 0, usedHere: false, resetsAt: RESETS };
  const USED_HERE = { remaining: 1, usedHere: true, resetsAt: RESETS };

  it('announces a free sticker when the reader actually has one', () => {
    expect(freeHintText(SLOTS_OPEN, READY)).toBe('Daily free sticker');
  });

  it('counts, when the reader can take more than one', () => {
    // Bounded by the smaller of the two, like the label — the hint must not
    // promise more than the image can accept.
    expect(
      freeHintText({ freeSlots: 4, freeSlotsRemaining: 3 }, { remaining: 2, usedHere: false })
    ).toBe('2 daily free stickers');
  });

  /**
   * 🔴 The silences, which are the whole reason this replaced a tooltip rather
   * than being added beside one.
   *
   * A popover that appears to tell you what you CANNOT have is an interruption
   * on somebody else's image. Every unavailable state says nothing at the bar
   * and is explained in the tray, at the point the choice is made.
   */
  it.each([
    ['the allowance is spent', SLOTS_OPEN, SPENT],
    ['a free one was already used here', SLOTS_OPEN, USED_HERE],
    ['the slot on this image is held', SLOTS_HELD, READY],
    ['the creator takes no free placements', NO_FREE, READY],
  ])('stays silent when %s', (_name, space, standing) => {
    expect(freeHintText(space, standing)).toBeNull();
  });

  it('claims nothing while either query is still loading', () => {
    expect(freeHintText(SLOTS_OPEN, undefined)).toBeNull();
    expect(freeHintText(undefined, READY)).toBeNull();
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

  /**
   * 🔴 The rung that had to be worded twice.
   *
   * `freeRefusalMessage`'s version is "Someone took the last free slot on this
   * image FIRST" — written for a placer who pressed and lost a race. Before the
   * press the reader has pressed nothing, so "first" is false, and the bar's own
   * bar said something different for the identical state, back when the bar
   * spoke at all. `FREE_SLOT_TAKEN_NOTE` is what survived, and this pins that
   * the pre-commit path does not fall through to the post-race wording.
   */
  it('does not tell someone who has pressed nothing that they lost a race', () => {
    const held = { freeSlots: 4, freeSlotsRemaining: 0 };
    const reason = preCommitFreeReason(false, READY, held);

    expect(reason).toBe(FREE_SLOT_TAKEN_NOTE);
    expect(reason).not.toMatch(/first/i);
    // The bar says nothing at all in this state now — no tooltip, and the hint
    // is only for a free placement the reader can actually take — so the tray is
    // the only place this sentence appears.
    expect(freeHintText(held, READY)).toBeNull();
  });

  /**
   * The ordering the substitution must not disturb: a permanent refusal still
   * outranks the transient one. Both conditions are true here, and the answer
   * has to be the one that does not lift by itself.
   */
  it('still prefers the permanent refusal when both are true', () => {
    expect(preCommitFreeReason(false, USED_HERE, { freeSlots: 4, freeSlotsRemaining: 0 })).toMatch(
      /already used a free sticker/
    );
    expect(preCommitFreeReason(false, SPENT, { freeSlots: 4, freeSlotsRemaining: 0 })).toMatch(
      /used today's free placement/
    );
  });
});

/**
 * The shared-allowance clause: one string that has to stay true to two rules it
 * does not own.
 */
describe('the shared-allowance note tracks the rules it describes', () => {
  /**
   * 🔴 The derivation is PARTIAL, and this is the tripwire for the half it does
   * not reach.
   *
   * The note says "one a day" from the constant, but the sentences around it are
   * singular and hand-written — "You have used today's free placement", "Your
   * free one is…", and `barFreeLabel`'s `Math.min`, which caps a label at the
   * allowance. Move the constant to 2 and the note updates while those keep
   * asserting one. So the note's own derivation is not enough on its own: this
   * asserts the value the rest of the copy is written for, and goes red if it
   * moves, pointing at the sentences that need rewriting.
   */
  it('fails if the daily count moves away from what the copy assumes', () => {
    expect(FREE_PLACEMENTS_PER_DAY).toBe(1);
  });

  it('reads its count from the rule rather than spelling one out', () => {
    // Goes red if `FREE_PLACEMENTS_PER_DAY` moves and the copy does not, which
    // is the whole reason the number is derived. "one" is the English for 1; any
    // other value renders as the digit.
    const expected = FREE_PLACEMENTS_PER_DAY === 1 ? 'one' : String(FREE_PLACEMENTS_PER_DAY);
    expect(SHARED_ALLOWANCE_NOTE.startsWith(`${expected} a day`)).toBe(true);
  });

  /**
   * 🔴 A rule someone can fail.
   *
   * The surface list is written out in English and cannot be derived, so nothing
   * would notice a third surface joining the shared budget — both surfaces would
   * quietly keep describing a two-way split. This is the tripwire: add a surface
   * to `PLACEMENT_SURFACES` and this goes red, pointing at the copy that needs
   * the third name.
   */
  it('fails if a surface is added to the shared budget without updating the copy', () => {
    expect(Object.keys(PLACEMENT_SURFACES).sort()).toEqual(['remixGallery', 'sticker']);
  });
});

/**
 * The decline caveat names the amount.
 *
 * Justin, using it: "we should tell them the exact amount... they keep X amount
 * of buzz, whatever that value is." A placer cannot work it out themselves —
 * the rate is operator-tunable and floors at 1⚡ — and it is the number that
 * actually leaves their wallet.
 */
describe('what the decline caveat says', () => {
  const paid = { freeAvailable: false, price: 500, review: true };

  it('names the amount the creator keeps', () => {
    const note = trayNotes({ ...paid, declineFee: 25 }).find((entry) => entry.id === 'decline');

    expect(note?.text).toBe('If they decline, they keep 25 Buzz');
  });

  /**
   * Not known yet is not zero. Before the space loads there is no fee to name,
   * and "they keep 0 Buzz" would be a false statement rather than a vague one.
   */
  it('stays vague while the fee is unknown', () => {
    const note = trayNotes(paid).find((entry) => entry.id === 'decline');

    expect(note?.text).toBe('If they decline, part of what you paid stays with them');
  });

  it('says nothing about money on a free placement', () => {
    const note = trayNotes({ ...paid, freeAvailable: true, declineFee: 25 }).find(
      (entry) => entry.id === 'decline'
    );

    expect(note?.text).not.toMatch(/Buzz/);
  });
});
