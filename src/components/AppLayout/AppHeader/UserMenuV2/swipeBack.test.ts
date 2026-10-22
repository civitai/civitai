import { describe, expect, it } from 'vitest';
import { isSwipeBack } from './swipeBack';

const from = { x: 20, y: 300, t: 0 };

describe('isSwipeBack', () => {
  it('takes a quick rightward flick', () => {
    expect(isSwipeBack(from, { x: 140, y: 310, t: 180 })).toBe(true);
  });

  it.each([
    ['a leftward flick', { x: -100, y: 300, t: 150 }],
    ['a short nudge', { x: 50, y: 300, t: 100 }],
    ['a vertical scroll that drifts right', { x: 90, y: 520, t: 200 }],
    ['a slow drag', { x: 200, y: 300, t: 1500 }],
  ])('ignores %s', (_name, end) => {
    expect(isSwipeBack(from, end)).toBe(false);
  });
});
