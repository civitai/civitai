import { readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  buildEntryScanCopy,
  buildScanCopy,
  buildWatermarkedPreview,
  PreviewRejectedError,
  watermarkSvg,
} from '~/server/utils/service-deal-preview';
import {
  SERVICE_PREVIEW_ANIMATED_MAX_FRAMES,
  SERVICE_PREVIEW_MAX_SIDE,
  SERVICE_PREVIEW_SCAN_SIDE,
} from '~/shared/constants/creator-services.constants';

/**
 * The preview a buyer sees is the product's weaker twin: small, marked on every frame, always
 * WebP. Real sharp, real bytes. The animated fixture is a repo asset (144 frames), sliced.
 */

const ANIMATED = join(process.cwd(), 'public/images/games/new-order-animated-bg.webp');
const FRAMES = 144;

/** A busy image, so a mark is measurable against it. */
async function still(
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'gif' | 'webp' = 'png'
) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .toFormat(format)
    .toBuffer();
}

const animated = (pages: number) =>
  sharp(ANIMATED, { animated: true, pages }).webp({ loop: 0 }).toBuffer();

/** Per-frame count of pixels that differ from the plain resize of the same source. */
async function markedPixelsPerFrame(source: Buffer, preview: Buffer) {
  const out = await sharp(preview, { animated: true }).metadata();
  const width = out.width!;
  const height = out.pageHeight ?? out.height!;
  const pages = out.pages ?? 1;
  const reference = await sharp(source, { animated: pages > 1 })
    .resize({ width, height, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const marked = await sharp(preview, { animated: pages > 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  const counts: number[] = [];
  for (let page = 0; page < pages; page++) {
    let changed = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const at = (page * width * height + pixel) * 3;
      if (
        Math.abs(marked[at] - reference[at]) > 40 ||
        Math.abs(marked[at + 1] - reference[at + 1]) > 40 ||
        Math.abs(marked[at + 2] - reference[at + 2]) > 40
      )
        changed++;
    }
    counts.push(changed / (width * height));
  }
  return counts;
}

describe('buildWatermarkedPreview', () => {
  it('downscales a large still so the long side is the cap, as WebP', async () => {
    const result = await buildWatermarkedPreview(await still(1600, 900));
    expect(result.mimeType).toBe('image/webp');
    expect(Math.max(result.width, result.height)).toBe(SERVICE_PREVIEW_MAX_SIDE);
    expect(result.width / result.height).toBeCloseTo(1600 / 900, 1);
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([result.width, result.height]);
  });

  it('never upscales a small image', async () => {
    const result = await buildWatermarkedPreview(await still(200, 120));
    expect([result.width, result.height]).toEqual([200, 120]);
  });

  it('burns the mark into the picture, visibly', async () => {
    const source = await still(800, 800);
    const result = await buildWatermarkedPreview(source);
    const [marked] = await markedPixelsPerFrame(source, result.data);
    // A tiled mark covers a real share of the frame, not a corner.
    expect(marked).toBeGreaterThan(0.03);
  });

  it('marks every frame of an animation, not only the first', async () => {
    const source = await animated(20);
    const result = await buildWatermarkedPreview(source);
    expect(result.frames).toBe(20);
    const meta = await sharp(result.data, { animated: true }).metadata();
    expect(meta.pages).toBe(20);
    const perFrame = await markedPixelsPerFrame(source, result.data);
    expect(perFrame).toHaveLength(20);
    expect(Math.min(...perFrame)).toBeGreaterThan(0.03);
  });

  it('takes a GIF in and always hands WebP out, animation kept', async () => {
    const gif = await sharp(await animated(12), { animated: true })
      .gif()
      .toBuffer();
    const result = await buildWatermarkedPreview(gif);
    expect(result.mimeType).toBe('image/webp');
    expect(result.frames).toBe(12);
    const perFrame = await markedPixelsPerFrame(gif, result.data);
    expect(Math.min(...perFrame)).toBeGreaterThan(0.03);
  });

  it('accepts exactly the frame cap and rejects one over, rather than truncating', async () => {
    const atCap = await buildWatermarkedPreview(
      await animated(SERVICE_PREVIEW_ANIMATED_MAX_FRAMES)
    );
    expect(atCap.frames).toBe(SERVICE_PREVIEW_ANIMATED_MAX_FRAMES);
    await expect(
      buildWatermarkedPreview(await animated(SERVICE_PREVIEW_ANIMATED_MAX_FRAMES + 1))
    ).rejects.toThrow(PreviewRejectedError);
    // The whole 144-frame asset, as a seller would send it.
    await expect(buildWatermarkedPreview(readFileSync(ANIMATED))).rejects.toThrow(
      /at most 60 frames/
    );
    expect(FRAMES).toBeGreaterThan(SERVICE_PREVIEW_ANIMATED_MAX_FRAMES);
  });

  it('decides by the bytes, not by what the upload claimed to be', async () => {
    await expect(buildWatermarkedPreview(Buffer.from('not an image at all'))).rejects.toThrow(
      PreviewRejectedError
    );
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(buildWatermarkedPreview(svg)).rejects.toThrow(/JPEG, PNG, WebP or GIF/);
  });

  it('draws the mark from shapes, so it needs no fonts in the image', () => {
    const svg = watermarkSvg(512, 512).toString();
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('<text');
  });
});

describe('the scan copies', () => {
  it('downscales to the scan side and leaves the picture unmarked', async () => {
    const source = await still(2400, 1200);
    for (const build of [buildScanCopy, buildEntryScanCopy]) {
      const result = await build(source);
      expect(Math.max(result.width, result.height)).toBe(SERVICE_PREVIEW_SCAN_SIDE);
      expect(result.mimeType).toBe('image/webp');
      const [marked] = await markedPixelsPerFrame(source, result.data);
      // The mark covers well over this share of a preview; a scan copy has none.
      expect(marked).toBeLessThan(0.005);
    }
  });

  it('keeps every frame of an animation, and refuses one over the frame cap', async () => {
    const result = await buildEntryScanCopy(await animated(20));
    expect(result.frames).toBe(20);
    await expect(buildEntryScanCopy(readFileSync(ANIMATED))).rejects.toThrow(/at most 60 frames/);
  });

  it('applies the preview byte cap to a preview and not to an image inside a delivery', async () => {
    // Trailing bytes after the image data are ignored by the decoder, so this is a valid 11 MB PNG.
    const big = Buffer.concat([await still(300, 300), Buffer.alloc(11 * 1024 * 1024)]);
    await expect(buildScanCopy(big)).rejects.toThrow(/too large/);
    const result = await buildEntryScanCopy(big);
    expect([result.width, result.height]).toEqual([300, 300]);
  });

  it('decides by the bytes', async () => {
    await expect(buildEntryScanCopy(Buffer.from('not an image at all'))).rejects.toThrow(
      PreviewRejectedError
    );
  });
});
