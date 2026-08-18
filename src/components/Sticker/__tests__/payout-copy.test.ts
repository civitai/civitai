import { describe, expect, it } from 'vitest';
import {
  declineConsequence,
  moderatorTakedownConsequence,
  payoutCopy,
  placementAmountLine,
  placementPaymentSummary,
  removalConsequence,
  removalLockReason,
  selectionFree,
  stickerPurchaseCopy,
} from '~/components/Sticker/payout-copy';

describe('payoutCopy', () => {
  // The whole reason the name is there. "The creator" is read while looking at
  // someone else's image wearing someone else's sticker, and both have one.
  it('names the person being paid', () => {
    expect(payoutCopy(1, 'justin')).toEqual({ lead: 'All proceeds go to', name: '@justin' });
  });

  // A deleted or nameless account must not produce "All proceeds go to" with
  // nothing after it.
  it('falls back to a whole sentence when there is no name', () => {
    for (const missing of [null, undefined, ''])
      expect(payoutCopy(1, missing)).toEqual({ lead: 'All proceeds go to the creator' });
  });

  // The sentence is derived from the resolved share, not compiled against
  // today's split, so an operator taking a cut changes the copy rather than
  // making it false.
  it('states the share whenever the owner does not keep all of it', () => {
    expect(payoutCopy(0.7, 'justin')).toEqual({
      lead: '70% of proceeds go to',
      name: '@justin',
    });
    expect(payoutCopy(0.7, null)).toEqual({ lead: '70% of proceeds go to the creator' });
  });

  it('rounds the share to whole percent rather than printing a float', () => {
    expect(payoutCopy(0.6667, 'a')?.lead).toBe('67% of proceeds go to');
  });

  // Saying nothing is the only honest thing to say before the number arrives.
  // A default would be a claim about money made while the answer is unknown.
  it('says nothing at all while the share is unknown', () => {
    expect(payoutCopy(undefined, 'justin')).toBeNull();
  });

  // Shares above 1 are not reachable through `clampApprovalShares`, but the
  // branch is `>= 1` rather than `=== 1` so a rounding artefact reads as "all"
  // instead of "100% of proceeds", which would be the same number said worse.
  it('treats anything at or above the whole as all of it', () => {
    expect(payoutCopy(1.0000001, null)).toEqual({ lead: 'All proceeds go to the creator' });
  });
});

describe('stickerPurchaseCopy', () => {
  // Read while three parties are in play — the image's owner, the sticker's
  // maker, and the site — with two payments about to happen in sequence.
  // "The creator" would name none of them unambiguously.
  it('names the sticker maker', () => {
    expect(stickerPurchaseCopy('justin')).toEqual({ lead: 'This goes to', name: '@justin' });
  });

  // Not a fallback: an official sticker genuinely has no maker to pay, and
  // saying so is more honest than a dangling "This goes to".
  it('says Civitai when there is explicitly no maker', () => {
    for (const missing of [null, ''])
      expect(stickerPurchaseCopy(missing)).toEqual({ lead: 'This goes to Civitai' });
  });

  // The distinction the whole signature exists for. A top-up dragged from the
  // owned row has no creator in its payload, and crediting the site there would
  // name the wrong recipient of real money.
  it('says nothing when the maker is unknown rather than absent', () => {
    expect(stickerPurchaseCopy(undefined)).toBeNull();
  });
});

/**
 * The money copy the OWNER decides on.
 *
 * Every sentence here is read at the moment somebody presses approve, decline or
 * remove, and each one asserts something about Buzz. The paid versions describe
 * the escrow's two holds, which a free row does not have — so on a free row they
 * are not loosely worded, they are false statements about money made where a
 * decision is taken and later repeated to support.
 */
describe('declineConsequence', () => {
  it('describes the two holds on a paid placement', () => {
    expect(declineConsequence(false)).toMatch(/keeps most of what they paid/);
  });

  it('claims no payment on a free one, and says what the placer does lose', () => {
    const free = declineConsequence(true);

    expect(free).not.toMatch(/paid for it|what they paid/);
    // The asymmetry the placer was warned about before pressing: the image's
    // slot comes back, their day does not. The owner deciding should see it too.
    expect(free).toMatch(/free placement for today is still spent/);
  });

  /**
   * `undefined` is a mixed bulk selection, not a missing value. Either concrete
   * sentence would be false about half of what is selected, so this branch says
   * only what covers both — and it must not read as one of them.
   */
  it('covers both kinds without asserting either, for a mixed selection', () => {
    const mixed = declineConsequence(undefined);

    expect(mixed).toMatch(/free placement moves no Buzz/);
    expect(mixed).toMatch(/fee staying with you/);
    expect(mixed).not.toBe(declineConsequence(true));
    expect(mixed).not.toBe(declineConsequence(false));
  });
});

describe('the removal copy', () => {
  it('gives the true reason for the week on each kind', () => {
    expect(removalLockReason(false)).toMatch(/Someone paid to place this/);
    expect(removalLockReason(true)).toMatch(/commitment to keep it up for a week/);
    // The client must not restate the paid reason on a free row — this mirrors
    // the server's refusal, which was corrected for the same reason.
    expect(removalLockReason(true)).not.toMatch(/paid/);
  });

  it('promises the owner no payment they never received', () => {
    expect(removalConsequence(false)).toMatch(/Buzz you were paid for it stays with you/);
    expect(removalConsequence(true)).not.toMatch(/you were paid/);
    expect(removalConsequence(true)).toMatch(/No Buzz was paid for it/);
  });

  it('says nobody is notified either way, which is true of both', () => {
    for (const free of [true, false])
      expect(removalConsequence(free)).toMatch(/nobody is notified/);
  });
});

/**
 * The queue row's headline, which is the only money statement on the card the
 * Approve and Decline buttons sit under — and the page the free-placement
 * notification sends the creator to.
 */
describe('placementPaymentSummary', () => {
  it('states the amount on a paid placement', () => {
    expect(placementPaymentSummary(700)).toBe('paid 700 Buzz');
  });
});

/**
 * The branch itself, which used to live inside `placementPaymentSummary` and
 * then briefly inside the page — where nothing can test it, because Next treats
 * every file under `src/pages` as a route.
 *
 * Both arms are asserted on purpose. Testing only the free one leaves the paid
 * line free to stop naming an amount; testing only the paid one leaves the free
 * row free to go back to claiming a payment of zero.
 */
describe('placementAmountLine', () => {
  /**
   * A free row is `amount: 0`, DB-enforced. Say the amount and the card asserts
   * a payment of zero directly above an irreversible choice, on the page a
   * notification saying "free" has just linked to.
   */
  it('names no amount on a free placement', () => {
    const line = placementAmountLine(true, 0);

    expect(line).toBe('placed this');
    expect(line).not.toMatch(/paid|Buzz|0/);
  });

  it('still states the amount on a paid one', () => {
    expect(placementAmountLine(false, 700)).toBe('paid 700 Buzz');
  });
});

describe('moderatorTakedownConsequence', () => {
  it('warns that a pending paid placement forfeits the whole escrow', () => {
    expect(moderatorTakedownConsequence({ pending: true, free: false })).toMatch(
      /forfeits everything the placer paid/
    );
  });

  it('says no Buzz moves on a live paid placement', () => {
    expect(moderatorTakedownConsequence({ pending: false, free: false })).toMatch(/No Buzz moves/);
  });

  /**
   * There is no escrow on a free row in either state, so the pending branch's
   * forfeit is a claim about money that does not exist — asserted at an
   * irreversible action a moderator is about to take.
   */
  it.each([true, false])('never claims a forfeit on a free row — pending %s', (pending) => {
    const free = moderatorTakedownConsequence({ pending, free: true });

    expect(free).not.toMatch(/forfeit|already paid|gets? nothing back/);
    expect(free).toMatch(/[Nn]othing was paid for it/);
    expect(free).toMatch(/nobody is notified/);
  });

  it('separates the two states on a free row too', () => {
    expect(moderatorTakedownConsequence({ pending: true, free: true })).not.toBe(
      moderatorTakedownConsequence({ pending: false, free: true })
    );
  });
});

/**
 * All free, all paid, or mixed — extracted from the queue page because the mixed
 * case is the one that matters and it was untestable inline.
 */
describe('selectionFree', () => {
  const rows = [
    { id: 1, free: true },
    { id: 2, free: true },
    { id: 3, free: false },
  ];

  it('reports a uniform selection', () => {
    expect(selectionFree([1, 2], rows)).toBe(true);
    expect(selectionFree([3], rows)).toBe(false);
  });

  /**
   * The mutation this exists for: collapsing to whichever kind came first makes a
   * bulk decline assert a sentence false of half the rows it is about.
   */
  it('reports mixed as undefined rather than picking a side', () => {
    expect(selectionFree([1, 3], rows)).toBeUndefined();
    expect(selectionFree([3, 1], rows)).toBeUndefined();
  });

  /**
   * An id whose row has not paged in yet is unknown, which makes the whole
   * selection mixed — the safe direction, because `declineConsequence` then says
   * only what covers both.
   */
  it('treats a row it cannot see as unknown', () => {
    expect(selectionFree([1, 99], rows)).toBeUndefined();
    expect(selectionFree([99], rows)).toBeUndefined();
  });

  it('says nothing about an empty selection', () => {
    expect(selectionFree([], rows)).toBeUndefined();
  });
});
