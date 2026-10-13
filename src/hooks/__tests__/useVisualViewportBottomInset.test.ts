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
