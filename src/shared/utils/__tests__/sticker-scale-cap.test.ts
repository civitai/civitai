import { describe, expect, it } from 'vitest';
import { capScaleFromWidth } from '~/shared/utils/sticker-placement';

/** The server refuses scale > maxScale, so no width may yield a scale above the limit, however float division rounds. */
const serverRefuses = (scale: number, maxScale: number) => scale > maxScale;

// Integer and fractional rendered widths, since layout widths are often fractional.
const WIDTHS = [
  ...Array.from({ length: 3000 }, (_, i) => 100 + i),
  ...Array.from({ length: 2000 }, (_, i) => 100.001 + i * 0.37),
];

describe('the resize ceiling', () => {
  it('never yields a scale the server refuses, at any width or limit', () => {
    for (const m of [0.05, 0.07, 0.1, 0.18, 0.22, 0.25, 0.35, 0.4]) {
      for (const w of WIDTHS) {
        expect(serverRefuses(capScaleFromWidth(m * w, w, m), m), `${m} @ ${w}`).toBe(false);
      }
    }
  });

  it('is a real sweep: the plain division it replaces overshoots at some of these widths', () => {
    expect(WIDTHS.some((w) => serverRefuses((0.22 * w) / w, 0.22))).toBe(true);
  });
});
