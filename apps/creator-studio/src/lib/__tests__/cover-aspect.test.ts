import { describe, expect, it } from 'vitest';
import { coverAspectWarning } from '../announcements';

describe('coverAspectWarning', () => {
  it('says nothing about a square cover', () => {
    expect(coverAspectWarning(1024, 1024)).toBeNull();
  });

  it('says nothing when the dimensions are unknown', () => {
    expect(coverAspectWarning(null, null)).toBeNull();
    expect(coverAspectWarning(1024, undefined)).toBeNull();
    expect(coverAspectWarning(0, 0)).toBeNull();
  });

  it('tolerates a few pixels of rounding', () => {
    expect(coverAspectWarning(1024, 1010)).toBeNull();
  });

  it('names the edge a landscape cover loses, at its real size in width-by-height order', () => {
    expect(coverAspectWarning(1920, 1080)).toBe(
      'This image is 1920×1080. Covers are shown as a square, so the sides will be cropped.'
    );
  });

  it('names the edge a portrait cover loses', () => {
    expect(coverAspectWarning(1080, 1920)).toContain('top and bottom');
  });
});
