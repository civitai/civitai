/**
 * Opt-in DOM capture for the feedback prompt.
 *
 * 🔴 PRIVACY POSTURE — OPT-IN WITH PREVIEW. This is a deliberate product decision,
 * not an implementation detail, and the guard below is the thing that enforces it.
 * A rendered capture of this site can contain NSFW imagery, another user's private
 * message content, or moderator-only UI. So:
 *   1. capture NEVER runs unless the caller passes an explicit consent flag,
 *   2. the caller shows the result to the user before anything is uploaded, and
 *   3. only the VIEWPORT is captured — what the reporter can actually see — not
 *      the whole scrollable document.
 * Do not "optimise" step 1 away by inferring consent from the presence of a
 * callback or from the prompt being open. Consent is a value the user set.
 *
 * 🔴 THE RENDERER IS `html2canvas-pro`, NOT `html2canvas`, AND THAT IS A BUG FIX.
 * `html2canvas@1.4.1` is that library's last release (Feb 2022) and predates CSS
 * Color Level 4: its colour parser THROWS — `Attempting to parse an unsupported
 * color function "<fn>"` — rather than degrading, so a SINGLE element anywhere in
 * the captured subtree whose computed colour is `color()`, `oklch()`, `oklab()`,
 * `lab()` or `lch()` takes the whole capture down. In production that was literally
 * one element in 3,998 on `/images`. Note this is a COMPUTED-style problem, not a
 * source-text one: `color-mix()` computes to `oklab(...)` and a P3 or relative
 * colour computes to `color(srgb ...)`, so the app can break without ever writing
 * one of those functions in a stylesheet — grepping the CSS proves nothing.
 * `html2canvas-pro` is the maintained fork that added exactly those parsers; it is
 * signature-identical and takes the same option names. Pinned by
 * `captureScreenshot.color4.browser.test.tsx`, which renders each function and
 * fails on the old library.
 *
 * 🔴 It (~250 kB) is reached ONLY through a dynamic `import()`, so it is code-split
 * out of the main bundle and costs nothing on the ~100% of page loads that never
 * open the prompt. That property is pinned by the source gate in
 * `src/server/services/__tests__/no-static-html2canvas-import.test.ts` — a static
 * `import html2canvas from 'html2canvas-pro'` anywhere under `src/` fails that test.
 * The fork is ~15 kB gzip LARGER than the library it replaces, so the split matters
 * slightly more now than it did, not less.
 */

/**
 * The subset of the renderer's real signature this module uses.
 *
 * Written against the published types (`html2canvas(element, options?) =>
 * Promise<HTMLCanvasElement>`), not against a convenient shape — a loader fake in a
 * test has to satisfy this, so a fake cannot encode a different contract from the
 * real dependency without a type error.
 */
export type Html2CanvasFn = (
  element: HTMLElement,
  options?: Record<string, unknown>
) => Promise<HTMLCanvasElement>;

export type Html2CanvasLoader = () => Promise<Html2CanvasFn>;

/** JPEG rather than PNG: a full-viewport PNG of an image feed is routinely 10x larger. */
export const SCREENSHOT_MIME_TYPE = 'image/jpeg';
export const SCREENSHOT_QUALITY = 0.8;
export const SCREENSHOT_FILENAME = 'page-capture.jpg';

/**
 * Hard ceiling on a capture the user did not choose the size of. A viewport JPEG at
 * quality 0.8 lands far below this; the cap exists so an unusually large viewport
 * cannot push a multi-megabyte upload through a control the user thinks of as "attach
 * a screenshot".
 */
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

const defaultLoader: Html2CanvasLoader = async () =>
  (await import('html2canvas-pro')).default as unknown as Html2CanvasFn;

export type CaptureScreenshotArgs = {
  /**
   * 🔴 THE CONSENT GATE. `true` means the user turned the control on themselves.
   * Anything else — `false`, `undefined`, a truthy non-boolean — is treated as no
   * consent and short-circuits before the dependency is even loaded.
   */
  consented: boolean;
  /** Defaults to `document.body`. Only the visible viewport region of it is drawn. */
  target?: HTMLElement | null;
  /** Seam for tests; production callers use the dynamic-import default. */
  loader?: Html2CanvasLoader;
};

export class ScreenshotTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`Screenshot is too large to attach (${bytes} bytes).`);
    this.name = 'ScreenshotTooLargeError';
  }
}

/**
 * Returns a JPEG `File` of the current viewport, or `null` when there is no consent
 * or nothing to capture.
 *
 * Returns `null` — rather than throwing — for the no-consent case specifically,
 * because "the user did not ask for a screenshot" is not an error condition. Real
 * capture failures (a rejected html2canvas, a canvas that will not encode, a
 * capture over the byte ceiling) DO throw, so the caller can tell "declined" from
 * "tried and failed" and say so.
 */
export async function captureConsentedScreenshot({
  consented,
  target,
  loader = defaultLoader,
}: CaptureScreenshotArgs): Promise<File | null> {
  // 🔴 The consent gate. Deliberately `!== true`, not falsy-check: this must not be
  // satisfiable by any value other than a real boolean true.
  if (consented !== true) return null;

  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const element = target ?? document.body;
  if (!element) return null;

  const html2canvas = await loader();

  // Viewport only. `x`/`y` are document coordinates of the current scroll position
  // and `width`/`height` the visible box, so nothing the reporter has scrolled past
  // is drawn. `allowTaint` stays false so a cross-origin image without CORS headers
  // is dropped from the capture rather than tainting the canvas and making
  // `toBlob` throw.
  //
  // 🔴 DO NOT ADD `scrollX: 0, scrollY: 0`. They look like they belong beside the
  // `x`/`y` crop and they are actively wrong. html2canvas builds `windowBounds` from
  // those two options and ADDS it to every cloned element's `getBoundingClientRect()`
  // to recover document coordinates, while separately scrolling the clone iframe to
  // the same values. The two cancel for in-flow content — which is why the mistake is
  // invisible in a static fixture — but NOT for `position: fixed`/`sticky` elements,
  // whose rect is viewport-relative by definition. Forcing both to 0 places the app's
  // sticky header at document y=0, outside the `y: window.scrollY` crop: the header
  // silently vanishes from every capture and the feed content it was covering is
  // drawn instead. That makes the checkbox's "Only what's on screen is captured"
  // false in BOTH directions. The defaults (`pageXOffset`/`pageYOffset`) are correct.
  // Pinned by `omits scrollX/scrollY` in captureScreenshot.test.ts and by the real
  // render fixture in captureScreenshot.render.browser.test.ts.
  const canvas = await html2canvas(element, {
    logging: false,
    useCORS: true,
    allowTaint: false,
    // html2canvas's default opaque white is deliberate here: the output is JPEG,
    // which has no alpha channel, so a transparent canvas would encode as black.
    scale: 1,
    x: window.scrollX,
    y: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
  });

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), SCREENSHOT_MIME_TYPE, SCREENSHOT_QUALITY);
  });
  if (!blob) throw new Error('Could not encode the page capture.');
  if (blob.size > SCREENSHOT_MAX_BYTES) throw new ScreenshotTooLargeError(blob.size);

  return new File([blob], SCREENSHOT_FILENAME, { type: SCREENSHOT_MIME_TYPE });
}
