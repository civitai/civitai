import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { copyMetadata as CopyMetadataFn } from '@civitai/generation-metadata';
import type * as ImageUtils from '~/utils/image-utils';

/**
 * Each local step of preparing an image for upload must fail as an ImagePrepError naming its
 * stage, so the generator can report where a device failed. With `stageTimeoutMs` a step that
 * never settles fails as timed out instead of hanging. The browser does the real reading, decoding
 * and encoding; only the steps a test has to break or hang are replaced.
 */

const mocks = vi.hoisted(() => ({
  createImageElement: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  copyMetadata: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock('~/utils/image-utils', async (orig) => {
  const actual = await orig<typeof ImageUtils>();
  return {
    ...actual,
    createImageElement: (...args: Parameters<typeof actual.createImageElement>) =>
      mocks.createImageElement
        ? mocks.createImageElement(...args)
        : actual.createImageElement(...args),
  };
});

vi.mock('@civitai/generation-metadata', async (orig) => {
  const actual = await orig<{ copyMetadata: typeof CopyMetadataFn }>();
  return {
    ...actual,
    copyMetadata: (...args: Parameters<typeof actual.copyMetadata>) =>
      mocks.copyMetadata ? mocks.copyMetadata(...args) : actual.copyMetadata(...args),
  };
});

// eslint-disable-next-line import/first
import { ImagePrepError, imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';

const never = () => new Promise<never>(() => undefined);

/**
 * Decodes `file` now, with real timers, and makes the next decodes return it. Fake timers would
 * otherwise time the real decode out first, and the test would report the wrong stage.
 */
async function decodeAhead(file: File) {
  const { createImageElement } = await vi.importActual<typeof ImageUtils>('~/utils/image-utils');
  const img = await createImageElement(file);
  mocks.createImageElement = async () => img;
}

/** A real PNG of the given size, so decoding and re-encoding run for real. */
async function pngFile(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  return new File([blob], 'photo.png', { type: 'image/png' });
}

/** Options that make resizeImage re-encode (the image is larger than the bound). */
const shrink = { maxWidth: 4, maxHeight: 4 };

async function stageOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ImagePrepError);
  const { stage, timedOut } = error as ImagePrepError;
  return { stage, timedOut };
}

describe('canvas-utils — staged image preparation', () => {
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  beforeEach(() => {
    mocks.createImageElement = undefined;
    mocks.copyMetadata = undefined;
  });
  afterEach(() => {
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
    vi.useRealTimers();
  });

  test('positive control: a readable image resizes and re-encodes', async () => {
    const out = await resizeImage(await pngFile(8, 8), shrink);
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBeGreaterThan(0);
  });

  // createImageElement releases the blob: url it made for a File once the image has loaded, so the
  // url does not hold an in-memory copy of a pick; the loaded element must still draw its pixels.
  test('an image read from a File keeps its pixels after the url made for it is released', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgb(200, 30, 60)';
    ctx.fillRect(0, 0, 8, 8);
    const png = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/png')
    );
    const file = new File([png], 'photo.png', { type: 'image/png' });
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    try {
      const out = await resizeImage(file, shrink);
      const made = create.mock.calls.flatMap(([obj], i) =>
        obj === file ? [create.mock.results[i].value as string] : []
      );
      expect(made).toHaveLength(1);
      expect(revoke).toHaveBeenCalledWith(made[0]);

      const img = await createImageBitmap(out);
      const check = document.createElement('canvas');
      check.width = img.width;
      check.height = img.height;
      const checkCtx = check.getContext('2d')!;
      checkCtx.drawImage(img, 0, 0);
      const [r, g, b] = checkCtx.getImageData(1, 1, 1, 1).data;
      // JPEG is lossy: close to the source colour, and nowhere near blank.
      expect(Math.abs(r - 200)).toBeLessThan(20);
      expect(Math.abs(g - 30)).toBeLessThan(20);
      expect(Math.abs(b - 60)).toBeLessThan(20);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  test('a picked file that can no longer be read fails at read-blob', async () => {
    const url = URL.createObjectURL(await pngFile(8, 8));
    URL.revokeObjectURL(url);
    expect(await stageOf(resizeImage(url, shrink))).toEqual({
      stage: 'read-blob',
      timedOut: false,
    });
    expect(await stageOf(imageToJpegBlob(url))).toEqual({ stage: 'read-blob', timedOut: false });
  });

  test('bytes the browser cannot decode fail at decode', async () => {
    const junk = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    expect(await stageOf(resizeImage(junk, shrink))).toEqual({ stage: 'decode', timedOut: false });
  });

  test('a canvas that produces no JPEG fails at encode', async () => {
    const file = await pngFile(8, 8);
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
      callback(null);
    };
    expect(await stageOf(resizeImage(file, shrink))).toEqual({ stage: 'encode', timedOut: false });
  });

  test('a failure copying metadata onto the JPEG fails at metadata', async () => {
    const file = await pngFile(8, 8);
    mocks.copyMetadata = () => Promise.reject(new Error('bad exif'));
    expect(await stageOf(resizeImage(file, shrink))).toEqual({
      stage: 'metadata',
      timedOut: false,
    });
  });

  test('a stage failure keeps the underlying message', async () => {
    const file = await pngFile(8, 8);
    mocks.copyMetadata = () => Promise.reject(new Error('bad exif'));
    await expect(resizeImage(file, shrink)).rejects.toThrow('bad exif');
  });

  describe('with a bound, a step that never settles times out', () => {
    async function timesOut(run: () => Promise<unknown>) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      const outcome = stageOf(run());
      await vi.advanceTimersByTimeAsync(30_000);
      return outcome;
    }

    test('decode', async () => {
      const file = await pngFile(8, 8);
      mocks.createImageElement = never;
      expect(
        await timesOut(() => resizeImage(file, { ...shrink, stageTimeoutMs: 30_000 }))
      ).toEqual({
        stage: 'decode',
        timedOut: true,
      });
    });

    test('encode', async () => {
      const file = await pngFile(8, 8);
      await decodeAhead(file);
      HTMLCanvasElement.prototype.toBlob = function () {
        // never calls back
      };
      expect(
        await timesOut(() => resizeImage(file, { ...shrink, stageTimeoutMs: 30_000 }))
      ).toEqual({
        stage: 'encode',
        timedOut: true,
      });
    });

    test('metadata', async () => {
      const file = await pngFile(8, 8);
      await decodeAhead(file);
      // Encoded ahead too, for the same reason as the decode.
      const jpeg = await new Promise<Blob>((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 8;
        originalToBlob.call(canvas, (b) => resolve(b!), 'image/jpeg');
      });
      HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
        callback(jpeg);
      };
      mocks.copyMetadata = never;
      expect(await timesOut(() => imageToJpegBlob(file, { stageTimeoutMs: 30_000 }))).toEqual({
        stage: 'metadata',
        timedOut: true,
      });
    });

    test('without a bound the same hang is not timed out (the bound is opt-in)', async () => {
      const file = await pngFile(8, 8);
      mocks.createImageElement = never;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      let settled = false;
      resizeImage(file, shrink).then(
        () => (settled = true),
        () => (settled = true)
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
    });
  });
});
