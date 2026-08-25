import { describe, expect, it } from 'vitest';
import {
  couldAwaitTosReacceptance,
  STRIKE_MUTE_REASON,
  tosReacceptanceOffer,
} from '~/server/common/tos-reacceptance';

/**
 * Who gets offered the Terms instead of a bare "your account has been restricted".
 *
 * Three things must stay true, and none of them typechecks: a moderator's mute is never liftable by
 * ticking a box; a mute applied for something OTHER than strikes must not be releasable by accepting
 * the Terms; and the review tier gets nothing, because there is nothing the user can do about it.
 */
const strikeMute = {
  muted: true,
  mutedAt: null,
  muteReason: STRIKE_MUTE_REASON,
};

describe('couldAwaitTosReacceptance (session-only first pass)', () => {
  it('rules out a moderator-set mute', () => {
    expect(couldAwaitTosReacceptance({ muted: true, mutedAt: new Date() })).toBe(false);
  });

  it('rules out an account that is not muted', () => {
    expect(couldAwaitTosReacceptance({ muted: false, mutedAt: null })).toBe(false);
    expect(couldAwaitTosReacceptance(null)).toBe(false);
    expect(couldAwaitTosReacceptance(undefined)).toBe(false);
  });

  it('lets a system-applied mute through to the full check', () => {
    expect(couldAwaitTosReacceptance({ muted: true, mutedAt: null })).toBe(true);
  });
});

describe('tosReacceptanceOffer', () => {
  it('offers at exactly the mute threshold', () => {
    expect(tosReacceptanceOffer({ ...strikeMute, activePoints: 2 })).toBe(true);
  });

  it('does NOT offer at the review tier — a moderator decides, the user cannot', () => {
    // Accepting would do nothing there, so showing the document is worse than the refusal.
    expect(tosReacceptanceOffer({ ...strikeMute, activePoints: 3 })).toBe(false);
    expect(tosReacceptanceOffer({ ...strikeMute, activePoints: 9 })).toBe(false);
  });

  it('does NOT offer below the mute threshold', () => {
    expect(tosReacceptanceOffer({ ...strikeMute, activePoints: 1 })).toBe(false);
    expect(tosReacceptanceOffer({ ...strikeMute, activePoints: 0 })).toBe(false);
  });

  it('does NOT offer to a mute applied for something other than strikes', () => {
    // The scam auto-mute and generation restrictions also leave `mutedAt` null. Accepting the Terms
    // must not release an account muted for either.
    expect(
      tosReacceptanceOffer({ ...strikeMute, muteReason: 'auto-mute-scam', activePoints: 2 })
    ).toBe(false);
    expect(tosReacceptanceOffer({ ...strikeMute, muteReason: null, activePoints: 2 })).toBe(false);
  });

  it('does NOT offer to a moderator-set mute even with strike points', () => {
    expect(tosReacceptanceOffer({ ...strikeMute, mutedAt: new Date(), activePoints: 2 })).toBe(
      false
    );
  });
});
