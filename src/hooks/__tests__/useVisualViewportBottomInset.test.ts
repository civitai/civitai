import { describe, expect, it } from 'vitest';

import { visualViewportBottomInset } from '~/hooks/useVisualViewportBottomInset';

describe('visualViewportBottomInset — the keyboard strip a fixed bottom sheet must clear', () => {
  it('keyboard up: the layout height the visual viewport no longer shows', () => {
    // 844px phone, 336px keyboard: the visual viewport is 508px tall, unpanned.
    expect(visualViewportBottomInset(844, { height: 508, offsetTop: 0 })).toBe(336);
  });

  it('iOS panned the visual viewport down: the pan is not keyboard', () => {
    expect(visualViewportBottomInset(844, { height: 508, offsetTop: 120 })).toBe(216);
  });

  it('keyboard down: 0', () => {
    expect(visualViewportBottomInset(844, { height: 844, offsetTop: 0 })).toBe(0);
  });

  it('rounds sub-pixel readings', () => {
    expect(visualViewportBottomInset(844, { height: 507.6, offsetTop: 0 })).toBe(336);
  });

  it('a pinch-zoomed page is not a keyboard, however large the gap', () => {
    // 2x zoom on an 844px layout: the visual viewport is 422px tall with no keyboard anywhere.
    expect(visualViewportBottomInset(844, { height: 422, offsetTop: 0, scale: 2 })).toBe(0);
    expect(visualViewportBottomInset(844, { height: 700, offsetTop: 0, scale: 0.8 })).toBe(0);
    // CONTROL: the same gap at scale 1 (and within float tolerance of it) is a keyboard.
    expect(visualViewportBottomInset(844, { height: 422, offsetTop: 0, scale: 1 })).toBe(422);
    expect(visualViewportBottomInset(844, { height: 422, offsetTop: 0, scale: 1.004 })).toBe(422);
  });

  it('a sliver under 100px (URL bar, scrollbar) is not a keyboard; 100px is', () => {
    expect(visualViewportBottomInset(844, { height: 788, offsetTop: 0, scale: 1 })).toBe(0);
    expect(visualViewportBottomInset(844, { height: 745, offsetTop: 0, scale: 1 })).toBe(0);
    expect(visualViewportBottomInset(844, { height: 744, offsetTop: 0, scale: 1 })).toBe(100);
  });

  it('the floor is on the keyboard height, not on what is left after a pan', () => {
    // A 336px keyboard, panned 250px: 86px of it still overlaps the layout viewport's bottom.
    expect(visualViewportBottomInset(844, { height: 508, offsetTop: 250, scale: 1 })).toBe(86);
    expect(visualViewportBottomInset(844, { height: 508, offsetTop: 335, scale: 1 })).toBe(1);
    // Panned all the way: nothing left to clear.
    expect(visualViewportBottomInset(844, { height: 508, offsetTop: 336, scale: 1 })).toBe(0);
  });

  it('never negative (pinch-zoomed out, or a taller visual viewport)', () => {
    expect(visualViewportBottomInset(844, { height: 900, offsetTop: 0 })).toBe(0);
  });

  it('no visualViewport, or unusable numbers: 0, i.e. the sheet stays where it was', () => {
    expect(visualViewportBottomInset(844, null)).toBe(0);
    expect(visualViewportBottomInset(844, undefined)).toBe(0);
    expect(visualViewportBottomInset(844, { height: Number.NaN, offsetTop: 0 })).toBe(0);
    expect(visualViewportBottomInset(Number.NaN, { height: 500, offsetTop: 0 })).toBe(0);
  });
});
