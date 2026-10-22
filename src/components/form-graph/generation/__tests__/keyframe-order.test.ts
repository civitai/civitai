import { describe, expect, it } from 'vitest';
import { byFrame, nextFrameIndex, swapImages } from '../inputs/keyframe-order';

const img = (n: number) => ({ url: `https://example.com/${n}.png` });
const entries = [
  { image: img(1), frameIndex: 0 },
  { image: img(2), frameIndex: 24 },
  { image: img(3), frameIndex: 96 },
];

describe('keyframe order', () => {
  it('a drag moves the image to another moment and leaves the moments where they were', () => {
    expect(swapImages(entries, 2, 0)).toEqual([
      { image: img(3), frameIndex: 0 },
      { image: img(1), frameIndex: 24 },
      { image: img(2), frameIndex: 96 },
    ]);
  });

  it('a settled list reads in time order', () => {
    expect(byFrame([entries[2], entries[0], entries[1]]).map((e) => e.frameIndex)).toEqual([
      0, 24, 96,
    ]);
  });

  it('a new keyframe lands one second after the last, inside the video, on a free frame', () => {
    expect(nextFrameIndex([], 120, 24)).toBe(0);
    expect(nextFrameIndex(entries, 240, 24)).toBe(120);
    expect(nextFrameIndex(entries, 100, 24)).toBe(100);
    expect(nextFrameIndex([{ image: img(1), frameIndex: 120 }], 120, 24)).toBe(119);
  });
});
