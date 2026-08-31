import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { captureConsentedScreenshot } from '~/components/Feedback/captureScreenshot';

/**
 * 🔴 RENDER SEAM — what the renderer actually DRAWS, not what options we passed it.
 *
 * `captureScreenshot.test.ts` pins the arguments. That is a real guard, and it is not
 * this one: passing `x: window.scrollY` and passing the RIGHT coordinate space are
 * different claims, and only one of them is about the picture the user gets. The
 * `scrollX: 0, scrollY: 0` defect lived exactly in that gap — every argument
 * assertion was green while the app's sticky header was silently missing from every
 * capture and the feed content behind it was drawn in its place.
 *
 * So this file runs the REAL html2canvas-pro against a REAL scrolled document in real
 * Chromium and reads pixels out of the produced JPEG. Keeping the negative control on
 * the SAME library the product uses is the point — it is what proved the fork kept
 * `scrollX`/`scrollY` defaulting to the page offsets when the renderer was swapped.
 *
 * 🔴 It carries its own NEGATIVE CONTROL. The first test re-applies the defect
 * through the same fixture and the same encode path, and requires the OPPOSITE
 * pixel. Without it, a green in the second test is indistinguishable from a fixture
 * where the header never landed at that pixel for unrelated reasons — the capture
 * could be blank, or cropped somewhere else entirely, and the assertion would still
 * pass. The two arms differ in exactly the two options under test.
 */

const BAR_HEIGHT = 200;
const BLUE_TOP = 1000;
const DOC_HEIGHT = 3000;
/** Where we sample. Inside the fixed bar when the coordinate space is right. */
const PROBE = { x: 10, y: 10 };

type Rgb = { r: number; g: number; b: number };

let fixture: HTMLElement[] = [];
let previousBodyMargin = '';

/**
 * A scrollable document with two landmarks:
 *  - a `position: fixed` red bar pinned to the VIEWPORT's top-left, and
 *  - a blue block at DOCUMENT y 1000..1200.
 * Scrolled to y=1000, the probe pixel is inside the red bar if fixed elements are
 * placed correctly, and inside the blue block if they are relocated to document y=0.
 */
function buildFixture() {
  previousBodyMargin = document.body.style.margin;
  document.body.style.margin = '0';

  const spacer = document.createElement('div');
  spacer.style.cssText = `height:${DOC_HEIGHT}px;width:100%;background:#ffffff;`;

  const blue = document.createElement('div');
  blue.style.cssText =
    `position:absolute;left:0;top:${BLUE_TOP}px;width:100%;height:200px;` +
    `background:rgb(0,0,255);z-index:1;`;

  const red = document.createElement('div');
  red.style.cssText =
    `position:fixed;left:0;top:0;width:100%;height:${BAR_HEIGHT}px;` +
    // Above everything the test runner itself might paint at the top-left.
    `background:rgb(255,0,0);z-index:2147483647;`;

  for (const el of [spacer, blue, red]) document.body.appendChild(el);
  fixture = [spacer, blue, red];
}

/** Decode a JPEG File and read one pixel. Both arms go through this same path. */
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

const encode = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
      'image/jpeg',
      0.8
    );
  });

// JPEG is lossy, so the assertions are on channel DOMINANCE rather than exact
// values. The two landmarks are pure red and pure blue precisely so the margin
// between them is far larger than any compression error.
const isRed = ({ r, g, b }: Rgb) => r > 180 && g < 90 && b < 90;
const isBlue = ({ r, g, b }: Rgb) => b > 180 && r < 90 && g < 90;

beforeEach(() => {
  buildFixture();
  window.scrollTo(0, BLUE_TOP);
});

afterEach(() => {
  for (const el of fixture) el.remove();
  fixture = [];
  document.body.style.margin = previousBodyMargin;
  window.scrollTo(0, 0);
});

describe('viewport capture places fixed/sticky elements correctly', () => {
  test('the fixture is genuinely scrolled — otherwise both arms are meaningless', () => {
    // A document that is not tall enough silently clamps `scrollTo`, and then the
    // buggy and correct coordinate spaces coincide and nothing below discriminates.
    expect(window.scrollY).toBe(BLUE_TOP);
    expect(window.innerHeight).toBeGreaterThan(0);
    expect(document.documentElement.scrollHeight).toBeGreaterThan(BLUE_TOP + window.innerHeight);
  });

  test('🔴 NEGATIVE CONTROL — with scrollX/scrollY forced to 0 the fixed bar is LOST', async () => {
    const html2canvas = (await import('html2canvas-pro')).default;
    const canvas = await html2canvas(document.body, {
      logging: false,
      useCORS: true,
      allowTaint: false,
      scale: 1,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      // THE DEFECT, reapplied deliberately. Everything else matches production.
      scrollX: 0,
      scrollY: 0,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    });

    const pixel = await pixelAt(await encode(canvas), PROBE.x, PROBE.y);

    // The bar is relocated to document y=0, outside the crop, so the probe lands on
    // the blue block that the bar was covering.
    expect(isBlue(pixel), `expected blue, got rgb(${pixel.r},${pixel.g},${pixel.b})`).toBe(true);
    expect(isRed(pixel)).toBe(false);
  });

  test('🔴 the shipped capture KEEPS the fixed bar the user can see', async () => {
    const file = await captureConsentedScreenshot({ consented: true });
    expect(file).toBeInstanceOf(File);

    const pixel = await pixelAt(file!, PROBE.x, PROBE.y);

    expect(isRed(pixel), `expected red, got rgb(${pixel.r},${pixel.g},${pixel.b})`).toBe(true);
    expect(isBlue(pixel)).toBe(false);
  });

  test('the capture is the viewport’s size, not the document’s', async () => {
    const file = await captureConsentedScreenshot({ consented: true });
    const bitmap = await createImageBitmap(file!);

    expect(bitmap.width).toBe(window.innerWidth);
    expect(bitmap.height).toBe(window.innerHeight);
    // The document is 3000px tall; a whole-document capture would be far larger.
    expect(bitmap.height).toBeLessThan(DOC_HEIGHT);
    bitmap.close();
  });
});
