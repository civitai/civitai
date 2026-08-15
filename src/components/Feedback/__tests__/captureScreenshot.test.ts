// @vitest-environment happy-dom
// The module reads `window`/`document` and builds a `File`, so the node default
// would fail for environmental reasons rather than for anything about the guard.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Html2CanvasFn } from '~/components/Feedback/captureScreenshot';
import {
  captureConsentedScreenshot,
  SCREENSHOT_FILENAME,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MIME_TYPE,
  ScreenshotTooLargeError,
} from '~/components/Feedback/captureScreenshot';

/**
 * 🔴 THE CONSENT GUARD. This is the load-bearing guarantee of the opt-in DOM-capture
 * design: a rendered capture of this site can contain NSFW imagery, another user's
 * private message content, or moderator-only UI, so nothing may be captured unless
 * the user turned the control on themselves.
 *
 * The guard is asserted STRUCTURALLY, not by a word on screen: the observable is
 * whether the html2canvas loader was invoked at all. A capture that never loads its
 * renderer cannot have produced a pixel, and no unrelated feature can spell that.
 *
 * The loader fake is typed as the real `Html2CanvasLoader`/`Html2CanvasFn`, which is
 * written from html2canvas's published signature — so the fake cannot encode a
 * different contract from the dependency without a type error.
 */

const { loader, html2canvas, toBlob } = vi.hoisted(() => {
  const toBlobMock = vi.fn();
  const html2canvasMock = vi.fn();
  return {
    toBlob: toBlobMock,
    html2canvas: html2canvasMock,
    loader: vi.fn(),
  };
});

/**
 * A canvas stand-in whose `toBlob` we control. `toBlob` is callback-style in the DOM
 * (`toBlob(callback, type?, quality?)`); the mime/quality arguments are still recorded
 * on `toBlob.mock.calls` and asserted below, so the implementation ignores them.
 */
const makeCanvas = (blob: Blob | null) => {
  toBlob.mockImplementation((callback: BlobCallback) => callback(blob));
  return { toBlob } as unknown as HTMLCanvasElement;
};

const jpeg = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: SCREENSHOT_MIME_TYPE });

beforeEach(() => {
  vi.clearAllMocks();
  html2canvas.mockResolvedValue(makeCanvas(jpeg(1024)));
  loader.mockResolvedValue(html2canvas as unknown as Html2CanvasFn);
});

describe('🔴 capture does not fire without explicit consent', () => {
  it('never loads html2canvas when consent is false', async () => {
    const result = await captureConsentedScreenshot({ consented: false, loader });

    expect(loader).not.toHaveBeenCalled();
    expect(html2canvas).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  // Every one of these is a value some caller could plausibly hand in — a missing
  // prop, a checkbox that was never touched, a truthy string from a query param, a
  // `1` from a serialised flag. The guard is `!== true`, so none of them capture.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an empty string', ''],
    ['the number 0', 0],
    ['an object', {}],
  ])('never loads html2canvas when consent is %s', async (_label, consented) => {
    const result = await captureConsentedScreenshot({
      consented: consented as unknown as boolean,
      loader,
    });

    expect(loader).not.toHaveBeenCalled();
    expect(html2canvas).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('short-circuits BEFORE touching the DOM, so a null target is irrelevant', async () => {
    // Reaching for `document.body` past the guard would be a capture attempt even if
    // it failed. This pins the ORDER: consent is checked first.
    const result = await captureConsentedScreenshot({
      consented: false,
      target: null,
      loader,
    });

    expect(result).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('capture fires with explicit consent', () => {
  it('loads html2canvas and returns a JPEG File', async () => {
    const result = await captureConsentedScreenshot({ consented: true, loader });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(html2canvas).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(File);
    expect(result?.name).toBe(SCREENSHOT_FILENAME);
    expect(result?.type).toBe('image/jpeg');
  });

  it('captures the given target rather than always document.body', async () => {
    const target = document.createElement('div');
    await captureConsentedScreenshot({ consented: true, target, loader });

    expect(html2canvas.mock.calls[0][0]).toBe(target);
  });

  it('defaults to document.body', async () => {
    await captureConsentedScreenshot({ consented: true, loader });

    expect(html2canvas.mock.calls[0][0]).toBe(document.body);
  });

  it('captures only the viewport, not the whole scrollable document', async () => {
    // The privacy half of the posture: anything the reporter scrolled past is not
    // drawn. Asserted as literals against a pinned window, not read back from the
    // call.
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(120);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(340);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);

    await captureConsentedScreenshot({ consented: true, loader });

    expect(html2canvas.mock.calls[0][1]).toMatchObject({
      x: 120,
      y: 340,
      width: 800,
      height: 600,
      allowTaint: false,
    });
  });

  it('encodes as JPEG rather than PNG', async () => {
    await captureConsentedScreenshot({ consented: true, loader });

    expect(toBlob.mock.calls[0][1]).toBe('image/jpeg');
    expect(toBlob.mock.calls[0][2]).toBe(0.8);
  });
});

describe('capture failures are distinguishable from "declined"', () => {
  it('throws when the canvas will not encode', async () => {
    html2canvas.mockResolvedValue(makeCanvas(null));

    await expect(captureConsentedScreenshot({ consented: true, loader })).rejects.toThrow(
      'Could not encode the page capture.'
    );
  });

  it('throws ScreenshotTooLargeError past the byte ceiling', async () => {
    html2canvas.mockResolvedValue(makeCanvas(jpeg(SCREENSHOT_MAX_BYTES + 1)));

    await expect(captureConsentedScreenshot({ consented: true, loader })).rejects.toBeInstanceOf(
      ScreenshotTooLargeError
    );
  });

  it('accepts a capture exactly at the ceiling', async () => {
    html2canvas.mockResolvedValue(makeCanvas(jpeg(SCREENSHOT_MAX_BYTES)));

    const result = await captureConsentedScreenshot({ consented: true, loader });
    expect(result).toBeInstanceOf(File);
  });

  it('propagates an html2canvas rejection rather than returning null', async () => {
    // Returning null here would be indistinguishable from "no consent" — the one
    // conflation this module must not make.
    html2canvas.mockRejectedValue(new Error('render failed'));

    await expect(captureConsentedScreenshot({ consented: true, loader })).rejects.toThrow(
      'render failed'
    );
  });

  it('pins the byte ceiling at 5 MiB', () => {
    expect(SCREENSHOT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
