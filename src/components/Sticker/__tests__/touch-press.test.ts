import { describe, expect, it } from 'vitest';
import type { TouchPressInput } from '~/components/Sticker/use-sticker-drag-out';
import {
  centreOfVisible,
  LONG_PRESS_MS,
  startTouchPress,
  TAP_MAX_MS,
  TOUCH_SLOP_PX,
  touchPressStep,
} from '~/components/Sticker/use-sticker-drag-out';

/** Feeds a finger's events through the press, collecting what each one asked for. */
const run = (...inputs: TouchPressInput[]) => {
  let press = startTouchPress(100, 100, 0);
  return inputs.map((input) => {
    const { next, action } = touchPressStep(press, input);
    press = next;
    return action;
  });
};

describe('a finger on a shelf sticker', () => {
  it('adds the sticker on a quick tap', () => {
    expect(run({ type: 'up', time: 120 })).toEqual(['tap']);
  });

  it('lets a swipe scroll the shelf: nothing is added and nothing is picked up', () => {
    expect(
      run(
        { type: 'move', x: 100, y: 100 - TOUCH_SLOP_PX - 1, time: 40 },
        { type: 'timer' },
        { type: 'up', time: 200 }
      )
    ).toEqual(['abort', undefined, undefined]);
  });

  it('does nothing when the browser takes the gesture as a scroll', () => {
    expect(run({ type: 'cancel' }, { type: 'up', time: 100 })).toEqual(['abort', undefined]);
  });

  it('ignores a finger settling before the press resolves', () => {
    expect(run({ type: 'move', x: 103, y: 104, time: 30 }, { type: 'up', time: 90 })).toEqual([
      undefined,
      'tap',
    ]);
  });

  it('picks the sticker up on a long press, then drags it', () => {
    expect(
      run({ type: 'timer' }, { type: 'move', x: 100, y: 40, time: LONG_PRESS_MS + 50 })
    ).toEqual(['arm', 'drag']);
  });

  it('drops nothing when a picked-up sticker is let go without moving', () => {
    expect(run({ type: 'timer' }, { type: 'up', time: LONG_PRESS_MS + 20 })).toEqual([
      'arm',
      'abort',
    ]);
  });

  it('treats a press held past a tap but released before pickup as nothing', () => {
    expect(run({ type: 'up', time: TAP_MAX_MS + 10 })).toEqual(['abort']);
  });
});

describe('where a tapped sticker lands', () => {
  const screen = { top: 0, bottom: 700, left: 0, right: 390 };

  it('is the middle of an image that is fully in view', () => {
    expect(centreOfVisible({ top: 100, bottom: 500, left: 0, right: 390 }, screen)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it('is the middle of the part still on screen when the image is scrolled up', () => {
    // 400px image with its top 300px scrolled off: the visible strip is 0..100.
    const { y } = centreOfVisible({ top: -300, bottom: 100, left: 0, right: 390 }, screen);
    expect(y).toBeCloseTo(0.875);
  });

  it('stays out from under the tray', () => {
    // The tray starts at 500; the image runs to 800.
    const { y } = centreOfVisible(
      { top: 200, bottom: 800, left: 0, right: 390 },
      { ...screen, bottom: 500 }
    );
    expect(y).toBeCloseTo(0.25);
  });

  it('falls back to the centre when none of the image is visible', () => {
    expect(centreOfVisible({ top: 800, bottom: 1200, left: 0, right: 390 }, screen)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });
});
