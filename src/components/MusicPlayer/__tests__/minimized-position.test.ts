import { describe, expect, it } from 'vitest';
import { pixelsToPosition, positionToPixels } from '~/components/MusicPlayer/minimized-position';

const SIZE = 80;
const desktop = { width: 1440, height: 800 };

describe('the minimized cover position', () => {
  it('round-trips pixels through viewport fractions', () => {
    const position = pixelsToPosition({ left: 720, top: 200 }, desktop, SIZE);
    expect(position).toEqual({ x: 0.5, y: 0.25 });
    expect(positionToPixels(position, desktop, SIZE)).toEqual({ left: 720, top: 200 });
  });

  it('clamps a drag past each edge inside the window', () => {
    expect(pixelsToPosition({ left: -50, top: -10 }, desktop, SIZE)).toEqual({ x: 0, y: 0 });
    const farCorner = pixelsToPosition({ left: 5000, top: 5000 }, desktop, SIZE);
    expect(positionToPixels(farCorner, desktop, SIZE)).toEqual({ left: 1360, top: 720 });
  });

  it('keeps its place proportionally on resize, still inside a smaller window', () => {
    const topRight = pixelsToPosition({ left: 1360, top: 0 }, desktop, SIZE);
    expect(positionToPixels(topRight, { width: 390, height: 700 }, SIZE)).toEqual({
      left: 310,
      top: 0,
    });
    const middle = pixelsToPosition({ left: 720, top: 400 }, desktop, SIZE);
    expect(positionToPixels(middle, { width: 1000, height: 600 }, SIZE)).toEqual({
      left: 500,
      top: 300,
    });
  });

  it('pins to the top-left in a window smaller than the cover', () => {
    expect(positionToPixels({ x: 0.9, y: 0.9 }, { width: 60, height: 60 }, SIZE)).toEqual({
      left: 0,
      top: 0,
    });
  });
});
