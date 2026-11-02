import { describe, expect, it } from 'vitest';
import {
  scaleFromWidth,
  snapScaleOvershoot,
  stickerMaxScale,
} from '~/shared/utils/sticker-placement';

/**
 * The editor must never submit a scale the server's strict `scale > maxScale`
 * check refuses. The resize handler clamps a pixel width to `maxScale * w` and
 * divides back; that round trip is not exact in floating point, so at some image
 * widths a sticker dragged to its full size came out a hair over the limit.
 */

const CAP = stickerMaxScale({ maxScale: 0.22 });
// What the server does, verbatim.
const serverRefuses = (scale: number, maxScale: number) => scale > maxScale;

// Integer and fractional rendered widths, since layout widths are often fractional.
const WIDTHS = [
  ...Array.from({ length: 3000 }, (_, i) => 100 + i),
  ...Array.from({ length: 2000 }, (_, i) => 100.001 + i * 0.37),
];

describe('the resize ceiling', () => {
  it('has widths where dividing the clamped width back overshoots (the defect)', () => {
    const overshoots = WIDTHS.filter((w) => serverRefuses((CAP * w) / w, CAP));
    expect(overshoots.length).toBeGreaterThan(0);
  });

  it('never yields a scale the server refuses, at any width', () => {
    for (const w of WIDTHS) {
      const scale = scaleFromWidth(CAP * w, w, CAP);
      expect(serverRefuses(scale, CAP), `width ${w}`).toBe(false);
    }
  });

  it('holds across several creator limits', () => {
    for (const m of [0.05, 0.07, 0.1, 0.18, 0.22, 0.25, 0.35, 0.4]) {
      for (const w of WIDTHS) {
        expect(serverRefuses(scaleFromWidth(m * w, w, m), m), `${m} @ ${w}`).toBe(false);
      }
    }
  });

  it('does not change a width below the limit', () => {
    expect(scaleFromWidth(100, 1000, CAP)).toBe(0.1);
  });
});

describe('the submit-side snap', () => {
  it('snaps a precision overshoot back to the limit', () => {
    const noisy = CAP + 2 ** -50;
    expect(serverRefuses(noisy, CAP)).toBe(true);
    expect(snapScaleOvershoot(noisy, CAP)).toBe(CAP);
  });

  it('leaves a real over-limit draft alone, so the server can refuse it honestly', () => {
    expect(snapScaleOvershoot(0.25, CAP)).toBe(0.25);
    expect(serverRefuses(snapScaleOvershoot(0.25, CAP), CAP)).toBe(true);
  });

  it('leaves a draft at or under the limit alone', () => {
    expect(snapScaleOvershoot(CAP, CAP)).toBe(CAP);
    expect(snapScaleOvershoot(0.1, CAP)).toBe(0.1);
  });
});
