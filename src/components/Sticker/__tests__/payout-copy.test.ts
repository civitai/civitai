import { describe, expect, it } from 'vitest';
import { payoutCopy } from '~/components/Sticker/payout-copy';

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
