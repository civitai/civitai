import { describe, expect, it } from 'vitest';
import { queueCountBadgeShape } from '~/components/Placement/queue-count-badge.shape';

/**
 * The rule this pins is a width rule, not a formatting one. `circle` sets the badge to
 * `width: var(--badge-height)` with 2px inline padding — 14px of text at size `sm` — so anything
 * two characters wide is clipped to "7…". That shipped: the menu badge read "7…" for a queue of 72.
 *
 * A rendering test that passes a single digit is green on both the broken and the fixed code, which
 * is why the discriminating cases below are the multi-character ones.
 */
describe('queueCountBadgeShape', () => {
  it('gives a single digit the disc', () => {
    expect(queueCountBadgeShape(7)).toEqual({ label: '7', circle: true });
  });

  it('gives a two-digit count the pill, not the disc', () => {
    // 🔴 The regression. `circle: true` here is what clipped "72" to "7…".
    expect(queueCountBadgeShape(72)).toEqual({ label: '72', circle: false });
  });

  it('gives a three-digit count the pill', () => {
    expect(queueCountBadgeShape(100)).toEqual({ label: '100', circle: false });
  });

  it('caps at max and keeps the pill so the + survives', () => {
    // The original bug this component was written for: "99+" in a disc renders "9…".
    expect(queueCountBadgeShape(546, { max: 99 })).toEqual({ label: '99+', circle: false });
  });

  it('does not cap a count equal to max', () => {
    expect(queueCountBadgeShape(99, { max: 99 })).toEqual({ label: '99', circle: false });
  });

  it('marks a truncated count with a + and keeps the pill', () => {
    expect(queueCountBadgeShape(50, { truncated: true })).toEqual({ label: '50+', circle: false });
  });

  it('keeps the pill for a truncated single digit, because the + is a second character', () => {
    // The one case where the digit count and the label length disagree.
    expect(queueCountBadgeShape(5, { truncated: true })).toEqual({ label: '5+', circle: false });
  });

  it('prefers the cap over the truncation marker when both apply', () => {
    expect(queueCountBadgeShape(500, { max: 99, truncated: true })).toEqual({
      label: '99+',
      circle: false,
    });
  });

  it('draws nothing at all for an empty queue', () => {
    expect(queueCountBadgeShape(0)).toBeNull();
    expect(queueCountBadgeShape(0, { max: 99 })).toBeNull();
  });
});
