import { decode, isBlurhashValid } from 'blurhash';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The server-side blurhash helper behind App Block image rows. Runs the real sharp decode and the
 * real blurhash encoder against real image bytes; only the log sink is replaced.
 */

// The failure log goes through the canonical logging mock (setup.ts).
const mockLog = loggingMock.logToAxiom;

import {
  blurhashMetadata,
  computeImageBlurhash,
  tryComputeImageBlurhash,
} from '~/server/utils/image-blurhash';

type Rgb = { r: number; g: number; b: number };

function solid(width: number, height: number, background: Rgb) {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

/** The average colour of a hash decoded back to pixels — what the placeholder actually shows. */
function decodedAverage(hash: string): Rgb {
  const px = decode(hash, 8, 8);
  const sum = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < px.length; i += 4) {
    sum.r += px[i];
    sum.g += px[i + 1];
    sum.b += px[i + 2];
  }
  const n = px.length / 4;
  return { r: sum.r / n, g: sum.g / n, b: sum.b / n };
}

beforeEach(() => {
  mockLog.mockClear();
});

describe('computeImageBlurhash', () => {
  it('returns a valid hash and the full-resolution pixel size', async () => {
    const result = await computeImageBlurhash(await solid(300, 200, { r: 200, g: 40, b: 40 }));

    expect(isBlurhashValid(result.hash).result).toBe(true);
    // Full-resolution, not the 64px raster the hash is encoded from.
    expect(result.width).toBe(300);
    expect(result.height).toBe(200);
  });

  it('measures a non-square image larger than the hash raster on both axes', async () => {
    const result = await computeImageBlurhash(await solid(1000, 1500, { r: 10, g: 10, b: 10 }));

    expect({ width: result.width, height: result.height }).toEqual({ width: 1000, height: 1500 });
  });

  it('encodes the image content: the placeholder shows the image colour', async () => {
    const red = await computeImageBlurhash(await solid(120, 80, { r: 220, g: 20, b: 20 }));
    const blue = await computeImageBlurhash(await solid(120, 80, { r: 20, g: 20, b: 220 }));

    expect(red.hash).not.toBe(blue.hash);
    const redAvg = decodedAverage(red.hash);
    const blueAvg = decodedAverage(blue.hash);
    expect(redAvg.r).toBeGreaterThan(redAvg.b + 100);
    expect(blueAvg.b).toBeGreaterThan(blueAvg.r + 100);
  });

  it('reports a quarter-turned JPEG the way a renderer shows it', async () => {
    const bytes = await sharp({
      create: { width: 450, height: 800, channels: 3, background: { r: 8, g: 8, b: 8 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await computeImageBlurhash(bytes);

    expect({ width: result.width, height: result.height }).toEqual({ width: 800, height: 450 });
  });

  it('rejects bytes that are not a decodable image', async () => {
    await expect(computeImageBlurhash(Buffer.from('not an image at all'))).rejects.toThrow();
  });
});

describe('tryComputeImageBlurhash', () => {
  it('returns the same result as computeImageBlurhash for a real image', async () => {
    const bytes = await solid(64, 32, { r: 1, g: 2, b: 3 });
    expect(await tryComputeImageBlurhash(bytes, { source: 'test' })).toEqual(
      await computeImageBlurhash(bytes)
    );
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('returns null and logs instead of throwing on undecodable bytes', async () => {
    const result = await tryComputeImageBlurhash(Buffer.from('not an image at all'), {
      source: 'test-source',
    });

    expect(result).toBeNull();
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toMatchObject({
      name: 'image-blurhash',
      source: 'test-source',
    });
  });
});

describe('blurhashMetadata', () => {
  it('is the hash/width/height keys an on-site upload stores', () => {
    expect(blurhashMetadata({ hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH', width: 7, height: 9 })).toEqual(
      { hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH', width: 7, height: 9 }
    );
  });

  it('adds no keys when there is no hash', () => {
    expect(blurhashMetadata(null)).toEqual({});
  });
});
