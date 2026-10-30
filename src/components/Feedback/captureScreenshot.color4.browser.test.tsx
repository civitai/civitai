import { afterEach, describe, expect, test } from 'vitest';
import { captureConsentedScreenshot } from '~/components/Feedback/captureScreenshot';

/**
 * 🔴 CSS COLOR LEVEL 4 — the capture must survive a page that uses modern colours.
 *
 * THE BUG THIS PINS. `html2canvas@1.4.1` (Feb 2022, that library's last release)
 * predates Color 4 and its parser THROWS rather than degrading:
 * `Attempting to parse an unsupported color function "color"`. It throws while
 * walking the cloned subtree, so it is not a per-element fallback — ONE element
 * anywhere in the capture takes the whole capture down. Measured in production on
 * `/images`: of 3,998 elements, exactly one computed to a Color 4 value (a
 * translucent-yellow pill at `color(srgb 1 0.878431 0.4 / 0.1)`), and the feature
 * was 100% broken for every user who ticked the box.
 *
 * 🔴 WHY THIS IS A COMPUTED-STYLE TEST AND NOT A STYLESHEET LINT. The app need never
 * write `color()` anywhere for this to fire. Browsers SERIALIZE into these forms:
 * `color-mix(in oklab, …)` computes to `oklab(…)`, a P3 or relative colour computes
 * to `color(srgb …)`. Measured in Chromium here — the `instrument:` cases below are
 * the check on that claim. A grep over `src/**` can come back clean
 * while every capture on the page fails, which is why sanitising colours before
 * capture was rejected in favour of a renderer that parses them.
 *
 * 🔴 EACH CASE ASSERTS A PIXEL, NOT JUST A RESOLVED PROMISE. A renderer that silently
 * skipped an unparseable colour would leave the capture technically successful and
 * visually wrong — the reporter would send us a screenshot missing the thing they
 * were reporting. Reading the drawn colour back out is what separates "parsed" from
 * "tolerated".
 */

type Rgb = { r: number; g: number; b: number };

/** JPEG is lossy, so assert channel DOMINANCE. Both targets are saturated primaries. */
const isRed = ({ r, g, b }: Rgb) => r > 180 && g < 90 && b < 90;
const isGreen = ({ r, g, b }: Rgb) => g > 180 && r < 90 && b < 90;

type Case = {
  label: string;
  /** Written into `style.backgroundColor`. */
  css: string;
  /** What `getComputedStyle` must still be serializing — the whole point of the case. */
  computedPrefix: string;
  expect: (pixel: Rgb) => boolean;
  expectLabel: string;
};

/**
 * Every value below is the SAME colour expressed in a different Color 4 function, so
 * a failure names the function rather than the colour. The `oklch`/`lab`/`lch`/`oklab`
 * quadruple is sRGB red; `color(srgb …)` is red directly; `color(display-p3 0 1 0)` is
 * a wide-gamut green that clamps into sRGB green on a 2D canvas.
 */
const CASES: Case[] = [
  {
    label: 'color(srgb …) — the function that broke production',
    css: 'color(srgb 1 0 0)',
    computedPrefix: 'color(srgb',
    expect: isRed,
    expectLabel: 'red',
  },
  {
    label: 'color(display-p3 …) — a wide-gamut source',
    css: 'color(display-p3 0 1 0)',
    computedPrefix: 'color(display-p3',
    expect: isGreen,
    expectLabel: 'green',
  },
  {
    label: 'oklch()',
    css: 'oklch(0.62796 0.25768 29.234)',
    computedPrefix: 'oklch(',
    expect: isRed,
    expectLabel: 'red',
  },
  {
    label: 'lab()',
    css: 'lab(54.29 80.8 69.89)',
    computedPrefix: 'lab(',
    expect: isRed,
    expectLabel: 'red',
  },
  {
    label: 'lch()',
    css: 'lch(54.29 106.84 40.85)',
    computedPrefix: 'lch(',
    expect: isRed,
    expectLabel: 'red',
  },
  {
    label: 'oklab()',
    css: 'oklab(0.62796 0.22486 0.12585)',
    computedPrefix: 'oklab(',
    expect: isRed,
    expectLabel: 'red',
  },
  {
    // 🔴 The one a source grep can never find. `color-mix()` does not survive into the
    // computed value at all — Chromium resolves it to `oklab(…)` — so a page can reach
    // the broken parser through a function that appears nowhere in the computed styles
    // AND a function that appears nowhere in the source.
    label: 'color-mix() — which computes to oklab()',
    css: 'color-mix(in oklab, red, red)',
    computedPrefix: 'oklab(',
    expect: isRed,
    expectLabel: 'red',
  },
];

/** The literal value measured on the live page, translucent alpha and all. */
const PRODUCTION_TRIGGER = 'color(srgb 1 0.878431 0.4 / 0.1)';

/** Inside the fixture block, well clear of any edge. */
const PROBE = { x: 10, y: 10 };

let fixture: HTMLElement | null = null;

/**
 * A viewport-covering block in the colour under test. `position: fixed` so it lands at
 * the probe pixel regardless of scroll, and a maximal z-index so nothing the runner
 * paints can sit on top of it and satisfy the assertion for the wrong reason.
 */
function paint(css: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;' +
    `background-color:${css};`;
  document.body.appendChild(el);
  fixture = el;
  return el;
}

async function pixelAt(file: Blob, x: number, y: number): Promise<Rgb> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  bitmap.close();
  return { r, g, b };
}

/**
 * Resolve the capture, or return the rejection so the assertion message can carry the
 * renderer's own words. Without this the failure reads as an unhandled rejection and
 * the actual diagnosis — which colour function, which parser — is lost from the output.
 */
async function capture(): Promise<File | Error> {
  try {
    const file = await captureConsentedScreenshot({ consented: true });
    return file ?? new Error('capture returned null despite explicit consent');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const describeResult = (result: File | Error) =>
  result instanceof Error ? `capture REJECTED: ${result.message}` : 'capture resolved';

afterEach(() => {
  fixture?.remove();
  fixture = null;
});

describe('page capture survives CSS Color Level 4 computed values', () => {
  /**
   * 🔴 INSTRUMENT CHECK, and it is not optional. Every case below is only meaningful
   * while Chromium still SERIALIZES these functions rather than normalising them to
   * `rgb()`. It normalises some already — `hwb(120 10% 20%)` computes to
   * `rgb(26, 204, 26)` and is therefore harmless — so "the browser normalises it" is a
   * real, observed behaviour and not a hypothetical. If a future Chromium starts doing
   * that to `oklch()` too, this test must go RED rather than let that case start
   * passing without ever exercising a Color 4 parser.
   */
  test.each(CASES.map((c) => [c.label, c] as const))(
    'instrument: %s still reaches the renderer as a Color 4 value',
    (_label, testCase) => {
      const el = paint(testCase.css);
      const computed = getComputedStyle(el).backgroundColor;

      expect(
        computed.startsWith(testCase.computedPrefix),
        `computed background-color was "${computed}", which does not start with ` +
          `"${testCase.computedPrefix}" — this case no longer exercises a Color 4 parser`
      ).toBe(true);
    }
  );

  test('instrument: the production trigger value survives computation verbatim', () => {
    const el = paint(PRODUCTION_TRIGGER);

    expect(getComputedStyle(el).backgroundColor).toBe(PRODUCTION_TRIGGER);
  });

  /**
   * 🔴 THE PRODUCTION REPRODUCTION. `html2canvas@1.4.1` fails this with
   * `Attempting to parse an unsupported color function "color"` — the exact string
   * users were shown under "Could not capture the page".
   */
  test(`captures a page containing ${PRODUCTION_TRIGGER}`, async () => {
    paint(PRODUCTION_TRIGGER);

    const result = await capture();

    expect(result, describeResult(result)).toBeInstanceOf(File);
  });

  test.each(CASES.map((c) => [c.label, c] as const))(
    'captures and DRAWS %s',
    async (_label, testCase) => {
      paint(testCase.css);

      const result = await capture();
      expect(result, describeResult(result)).toBeInstanceOf(File);

      const pixel = await pixelAt(result as File, PROBE.x, PROBE.y);
      expect(
        testCase.expect(pixel),
        `expected ${testCase.expectLabel}, got rgb(${pixel.r},${pixel.g},${pixel.b}) — ` +
          `the capture succeeded but did not draw ${testCase.css}`
      ).toBe(true);
    }
  );

  /**
   * A legacy-serializing function, kept as the CONTRAST case. It computes to `rgb()`,
   * so it went through the old renderer untouched: a suite where this one case is the
   * only green is a suite that has not tested anything the fix is about.
   */
  test('hwb() computes to rgb() and was never the problem', async () => {
    const el = paint('hwb(0 0% 0%)');
    expect(getComputedStyle(el).backgroundColor).toBe('rgb(255, 0, 0)');

    const result = await capture();
    expect(result, describeResult(result)).toBeInstanceOf(File);
    expect(isRed(await pixelAt(result as File, PROBE.x, PROBE.y))).toBe(true);
  });
});
