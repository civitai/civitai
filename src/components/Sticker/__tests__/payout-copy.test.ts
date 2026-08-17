import { describe, expect, it } from 'vitest';
import {
  declineConsequence,
  payoutCopy,
  removalConsequence,
  removalLockReason,
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
