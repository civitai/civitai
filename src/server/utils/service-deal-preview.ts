import {
  SERVICE_PREVIEW_ANIMATED_MAX_BYTES,
  SERVICE_PREVIEW_ANIMATED_MAX_FRAMES,
  SERVICE_PREVIEW_MAX_BYTES,
  SERVICE_PREVIEW_MAX_SIDE,
  SERVICE_PREVIEW_SCAN_SIDE,
} from '~/shared/constants/creator-services.constants';

/** The seller can fix this by uploading something else; the message goes back to them as it is. */
export class PreviewRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewRejectedError';
  }
}

const SNIFFED_FORMATS = ['jpeg', 'png', 'webp', 'gif'];
/** Decoded pixels across all frames. Well above the 512px output, far below a decompression bomb. */
const MAX_INPUT_PIXELS = 100_000_000;

/**
 * 5x7 block letters. The mark is drawn from rectangles rather than text because the production
 * image ships no fonts: a text watermark would render as blank boxes there.
 */
const GLYPHS: Record<string, string[]> = {
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
};
const WORD = 'PREVIEW';
const CELL = 5;
const GLYPH_GAP = 1;

function wordRects() {
  const rects: string[] = [];
  let x = 0;
  for (const letter of WORD) {
    GLYPHS[letter].forEach((row, y) =>
      [...row].forEach((on, col) => {
        if (on === '1')
          rects.push(
            `<rect x="${(x + col) * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}"/>`
          );
      })
    );
    x += 5 + GLYPH_GAP;
  }
  return { rects: rects.join(''), width: (x - GLYPH_GAP) * CELL, height: 7 * CELL };
}

/** A tile that repeats across the whole frame, so cropping any part of it keeps the mark. */
export function watermarkSvg(width: number, height: number) {
  const word = wordRects();
  const padX = 24;
  const padY = 40;
  const tileW = word.width + padX * 2;
  const tileH = word.height + padY * 2;
  const mark = (fill: string, opacity: number, dx = 0, dy = 0) =>
    `<g transform="translate(${padX + dx} ${padY + dy})" fill="${fill}" fill-opacity="${opacity}">${
      word.rects
    }</g>`;
  // A dark offset copy under a light one keeps the mark legible on both light and dark art.
  const tile = `<pattern id="t" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)">${mark(
    '#000',
    0.45,
    1.5,
    1.5
  )}${mark('#fff', 0.6)}</pattern>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${tile}</defs><rect width="${width}" height="${height}" fill="url(#t)"/></svg>`
  );
}

export type PreviewResult = {
  data: Buffer;
  mimeType: 'image/webp';
  width: number;
  height: number;
  frames: number;
};

/** Caps that depend on the file's size, checked before any decoding. */
export function assertPreviewBytes(size: number, animatedPossible: boolean) {
  const max = animatedPossible ? SERVICE_PREVIEW_ANIMATED_MAX_BYTES : SERVICE_PREVIEW_MAX_BYTES;
  if (size > max)
    throw new PreviewRejectedError(
      `Preview is too large (max ${Math.floor(max / (1024 * 1024))} MB).`
    );
}

/**
 * Reads and checks an uploaded preview, then scales it down so its long side is at most `maxSide`
 * (never up). The format is sniffed from the bytes, never taken from the declared type, and an
 * animation over the frame cap is rejected rather than truncated: a shortened preview misrepresents
 * the work.
 */
async function prepare(input: Buffer, maxSide: number, { previewCaps = true } = {}) {
  const sharp = (await import('sharp')).default;
  const open = () => sharp(input, { animated: true, limitInputPixels: MAX_INPUT_PIXELS });

  let meta;
  try {
    meta = await open().metadata();
  } catch {
    throw new PreviewRejectedError('This file could not be read as an image.');
  }
  if (!meta.format || !SNIFFED_FORMATS.includes(meta.format))
    throw new PreviewRejectedError('Previews must be JPEG, PNG, WebP or GIF images.');

  const frames = meta.pages ?? 1;
  const animated = frames > 1;
  if (animated && frames > SERVICE_PREVIEW_ANIMATED_MAX_FRAMES)
    throw new PreviewRejectedError(
      `Animated previews can have at most ${SERVICE_PREVIEW_ANIMATED_MAX_FRAMES} frames (this one has ${frames}).`
    );
  if (previewCaps) assertPreviewBytes(input.byteLength, animated);

  const pageW = meta.width;
  const pageH = meta.pageHeight ?? meta.height;
  if (!pageW || !pageH) throw new PreviewRejectedError('This file could not be read as an image.');

  const scale = Math.min(1, maxSide / Math.max(pageW, pageH));
  const width = Math.max(1, Math.round(pageW * scale));
  const height = Math.max(1, Math.round(pageH * scale));

  let resized: Buffer;
  try {
    resized = await (animated ? open() : open().rotate())
      .resize({ width, height, fit: 'fill' })
      .toBuffer();
  } catch {
    throw new PreviewRejectedError('This file could not be read as an image.');
  }
  return { sharp, resized, animated, frames, width, height };
}

/**
 * What gets scanned: the preview downscaled to SERVICE_PREVIEW_SCAN_SIDE and left unmarked. It goes
 * to the image store only to be scanned and is deleted once the verdict lands. Same checks and
 * caps as the published preview.
 */
export const buildScanCopy = (input: Buffer) => scanCopy(input, true);

async function scanCopy(input: Buffer, previewCaps: boolean): Promise<PreviewResult> {
  const { sharp, resized, animated, frames, width, height } = await prepare(
    input,
    SERVICE_PREVIEW_SCAN_SIDE,
    { previewCaps }
  );
  const data = await sharp(resized, { animated })
    .webp({ quality: 80, effort: 3, loop: 0 })
    .toBuffer();
  return { data, mimeType: 'image/webp', width, height, frames };
}

/**
 * The scan copy of an image inside a delivered file. Same downscale, format sniff and frame cap as
 * a preview's, but the byte cap is the caller's (the archive reader has already enforced its own).
 */
export const buildEntryScanCopy = (input: Buffer) => scanCopy(input, false);

/**
 * The only thing a buyer ever sees of a preview: downscaled so the long side is at most
 * SERVICE_PREVIEW_MAX_SIDE, with a tiled mark burned into every frame, always as WebP. An animated
 * input keeps its animation.
 */
export async function buildWatermarkedPreview(input: Buffer): Promise<PreviewResult> {
  const { sharp, resized, animated, frames, width, height } = await prepare(
    input,
    SERVICE_PREVIEW_MAX_SIDE
  );

  const tile = await sharp(watermarkSvg(width, height)).png().toBuffer();
  // One overlay as tall as the whole animation: a plain composite would mark the first frame only.
  const overlay = animated
    ? await sharp({
        create: {
          width,
          height: height * frames,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite(
          Array.from({ length: frames }, (_, i) => ({ input: tile, top: i * height, left: 0 }))
        )
        .png()
        .toBuffer()
    : tile;

  const data = await sharp(resized, { animated })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .webp({ quality: 70, effort: 3, loop: 0 })
    .toBuffer();

  return { data, mimeType: 'image/webp', width, height, frames };
}
