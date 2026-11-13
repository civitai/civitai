import { describe, expect, it } from 'vitest';
import {
  releaseVelocity,
  shouldGoBack,
  SWIPE_COMMIT_FRACTION,
  SWIPE_FLICK_MIN_PX,
  SWIPE_FLICK_VELOCITY,
  SWIPE_SLOP_PX,
  swipeIntent,
} from './swipeBack';

describe('swipeIntent', () => {
  it('waits out the slop before deciding', () => {
    expect(swipeIntent(SWIPE_SLOP_PX - 2, 0)).toBeUndefined();
    expect(swipeIntent(0, 0)).toBeUndefined();
  });

  it('takes a mostly horizontal rightward drag as a swipe back', () => {
    expect(swipeIntent(SWIPE_SLOP_PX + 2, 2)).toBe('back');
    expect(swipeIntent(120, 50)).toBe('back');
  });

  it.each([
    ['a vertical scroll', 3, 40],
    ['a scroll that drifts right', 40, 60],
    ['a leftward drag', -40, 2],
    ['a steep diagonal', 30, 20],
  ])('leaves %s to the browser', (_name, dx, dy) => {
    expect(swipeIntent(dx, dy)).toBe('scroll');
  });
});

describe('releaseVelocity', () => {
  const at = (x: number, t: number) => ({ x, y: 0, t });

  it('reads the speed over the last moments', () => {
    expect(releaseVelocity([at(0, 0), at(30, 40), at(90, 80)], 90)).toBeCloseTo(90 / 80);
  });

  it('is zero once the finger has rested', () => {
    expect(releaseVelocity([at(0, 0), at(60, 20)], 400)).toBe(0);
  });

  it('is negative for a drag that turns back', () => {
    expect(releaseVelocity([at(150, 0), at(60, 40)], 45)).toBeLessThan(0);
  });

  it('needs two samples', () => {
    expect(releaseVelocity([at(10, 0)], 5)).toBe(0);
  });

  it('is zero for samples with no time between them, not infinite', () => {
    expect(releaseVelocity([at(0, 10), at(50, 10)], 10)).toBe(0);
  });
});

describe('shouldGoBack', () => {
  const width = 400;
  const dragged = (fraction: number) => width * fraction;

  it('goes back past the commit distance, and not short of it, at rest', () => {
    expect(shouldGoBack({ dx: dragged(SWIPE_COMMIT_FRACTION), width, velocity: 0 })).toBe(true);
    expect(shouldGoBack({ dx: dragged(SWIPE_COMMIT_FRACTION) - 1, width, velocity: 0 })).toBe(
      false
    );
  });

  it('goes back on a quick flick from a short distance', () => {
    expect(shouldGoBack({ dx: SWIPE_FLICK_MIN_PX, width, velocity: SWIPE_FLICK_VELOCITY })).toBe(
      true
    );
  });

  it('ignores a flick that did not travel', () => {
    expect(
      shouldGoBack({ dx: SWIPE_FLICK_MIN_PX - 1, width, velocity: SWIPE_FLICK_VELOCITY * 4 })
    ).toBe(false);
  });

  it('ignores a slow drag short of the distance', () => {
    expect(shouldGoBack({ dx: dragged(0.2), width, velocity: SWIPE_FLICK_VELOCITY - 0.01 })).toBe(
      false
    );
  });

  it('stays put when a long drag is flicked back', () => {
    expect(shouldGoBack({ dx: dragged(0.8), width, velocity: -SWIPE_FLICK_VELOCITY })).toBe(false);
  });
});
