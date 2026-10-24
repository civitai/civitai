import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { AnimatedCount } from '~/components/Metrics/AnimatedCount';
import { nextLayout, renderWithProviders } from '../../../test/geometry-setup';

/**
 * Every digit 0-9 paints on the same pixel row as the same glyph in plain text.
 *
 * The digit stack rolls to show digit n, so each column sits at a different offset. Firefox at a
 * fractional device pixel ratio (a 225% Windows display is 2.25) rounded those offsets differently
 * per digit, and "1" painted a device pixel lower than "0" in "102". Layout boxes agree, so each
 * case screenshots an animated digit beside the same digit as plain text and compares ink.
 *
 * CI runs Chromium at DPR 1, which does not show this. To see it fail on the old transform roll:
 *   GEOMETRY_BROWSER=firefox GEOMETRY_DPR=2.25 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<firefox binary> \
 *     pnpm vitest run --project geometry src/components/Metrics/CustomNumberFlow.digitRows
 */

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

afterEach(() => {
  document.documentElement.style.fontSize = '';
});

/** Vertical ink centre of a box inside a screenshot of `host`, in device pixels. */
async function inkCentre(host: Element, box: DOMRect) {
  const base64 = await page.elementLocator(host).screenshot({ save: false });
  const img = new Image();
  img.src = `data:image/png;base64,${base64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  const hostBox = host.getBoundingClientRect();
  const scale = img.width / hostBox.width;
  const x0 = Math.floor((box.left - hostBox.left) * scale);
  const x1 = Math.ceil((box.right - hostBox.left) * scale);
  // Only this box's rows (plus a margin for a shifted digit), so the other row of the grid is not blended in.
  const y0 = Math.max(0, Math.floor((box.top - hostBox.top - 3) * scale));
  const y1 = Math.min(img.height, Math.ceil((box.bottom - hostBox.top + 3) * scale));
  let total = 0;
  let weighted = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ink = 255 - data[(y * img.width + x) * 4];
      total += ink;
      weighted += ink * y;
    }
  }
  return weighted / total;
}

/** Animated-minus-plain ink centre for each digit, in device pixels. */
async function deltas(offsetPx: number, shiftOdd = false) {
  document.documentElement.style.fontSize = '16px';
  // One row per digit, animated beside plain text on a shared baseline: the baseline alignment is
  // what puts the digit at a fractional position, which is where browsers round it.
  renderWithProviders(
    <div
      style={{
        background: '#fff',
        color: '#000',
        fontSize: 14,
        fontWeight: 700,
        paddingTop: offsetPx,
      }}
    >
      {DIGITS.map((n) => (
        <div
          key={n}
          data-testid={`row${n}`}
          style={{ display: 'flex', alignItems: 'baseline', gap: 30, width: 200, padding: 10 }}
        >
          <span data-animated>
            <AnimatedCount value={n} abbreviate={false} />
          </span>
          <span data-plain style={{ lineHeight: 1 }}>
            {n}
          </span>
        </div>
      ))}
    </div>
  );
  await nextLayout();
  await Promise.all(document.getAnimations().map((a) => a.finished));
  const out: number[] = [];
  for (const n of DIGITS) {
    const row = document.querySelector(`[data-testid="row${n}"]`)!;
    const a = row.querySelector('[data-animated] [data-testid="cnf-digit"]')!;
    const p = row.querySelector('[data-plain]')!;
    // Control: nudge every odd digit down 2 CSS px, which the measurement must see.
    if (shiftOdd && n % 2) (a as HTMLElement).style.transform = 'translateY(2px)';
    const ca = await inkCentre(row, a.getBoundingClientRect());
    const cp = await inkCentre(row, p.getBoundingClientRect());
    out.push(ca - cp);
  }
  return out;
}

const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

describe('CustomNumberFlow digit rows', () => {
  // The row's fractional position decides how a browser rounds each digit, so try several.
  test.each([0, 0.25, 0.5, 0.75])(
    'every digit paints on the same row (offset %fpx)',
    async (offset) => {
      const d = await deltas(offset);
      // Plain text sits on a different line box, so only the spread across digits is meaningful.
      // A one device pixel step is 1.0; allow antialiasing noise well below that.
      expect(spread(d), `per-digit offsets ${d.map((x) => x.toFixed(2)).join(' ')}`).toBeLessThan(
        0.3
      );
    }
  );

  test('the measurement sees a 2px shift of the odd digits', async () => {
    const d = await deltas(0, true);
    expect(spread(d)).toBeGreaterThan(0.8);
  });
});
