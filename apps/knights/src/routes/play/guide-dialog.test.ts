import { describe, expect, it } from 'vitest';
import { closeGuide, guideShowing, openGuide, settleGuide, type GuideState } from './guide-dialog';

const fresh = (): GuideState => ({ reopened: false, dismissed: false });

describe('rating guide dialog', () => {
  it('shows the first-visit guide, and nothing otherwise until it is reopened', () => {
    expect(guideShowing(true, fresh())).toBe(true);
    expect(guideShowing(false, fresh())).toBe(false);
    const state = fresh();
    openGuide(state);
    expect(guideShowing(false, state)).toBe(true);
  });

  it('is gone the moment "I understand" is pressed, before the server answers', () => {
    const first = fresh();
    closeGuide(first);
    expect(guideShowing(true, first)).toBe(false);

    const reopened = fresh();
    openGuide(reopened);
    closeGuide(reopened);
    expect(guideShowing(false, reopened)).toBe(false);
  });

  it('stays closed once the server records it', () => {
    const state = fresh();
    const before = closeGuide(state);
    settleGuide(state, true, before);
    expect(guideShowing(true, state)).toBe(false);
  });

  it('comes back when the server could not record it, so the player can press again', () => {
    const state = fresh();
    const before = closeGuide(state);
    settleGuide(state, false, before);
    expect(guideShowing(true, state)).toBe(true);
  });

  it('opens again from the Guide button after the first-visit guide was closed', () => {
    const state = fresh();
    settleGuide(state, true, closeGuide(state));
    openGuide(state);
    expect(guideShowing(true, state)).toBe(true);
  });
});
