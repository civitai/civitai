/**
 * The one magic-byte image sniffer, shared by client and server code (pure: no Node or DOM
 * imports, takes a `Uint8Array`, which a Node `Buffer` also is).
 *
 * Callers deliberately accept different things, so each states its own rules rather than the
 * module picking one set for everybody:
 *   - `sniffSaveBytesImage` (SAVE_IMAGE bytes, client): PNG / WebP / JPEG, full PNG signature.
 *   - `detectImageType` (bundle screenshots): PNG / WebP / JPEG, full PNG signature, and the
 *     WebP markers matched with the high bit cleared (see `webpFourCcIgnoresHighBit`).
 *   - `sniffSupportedImage` (block image upload): JPEG / PNG / GIF / WebP, 4-byte PNG prefix,
 *     and nothing shorter than 12 bytes.
 * Pinned across all three by `image-sniffer-characterisation.test.ts`.
 */

export type ImageMagicFormat = 'jpeg' | 'png' | 'gif' | 'webp';

export type ImageSniffOptions = {
  /** The formats this caller accepts. Anything else, even a recognisable image, returns null. */
  formats: readonly ImageMagicFormat[];
  /** `full`: the 8-byte PNG signature. `prefix`: only its first 4 bytes (`\x89PNG`). */
  pngSignature: 'full' | 'prefix';
  /** Refuse any input shorter than this, whatever its format. */
  minLength?: number;
  /**
   * Compare the WebP `RIFF` / `WEBP` markers with each byte's high bit cleared, so `0xd2` matches
   * `R`. Exists ONLY to keep `detectImageType`'s accepted set unchanged: it compared them through
   * Node's `Buffer#toString('ascii')`, which clears the high bit. Not a rule to copy.
   */
  webpFourCcIgnoresHighBit?: boolean;
};

const PNG_FULL = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_PREFIX = PNG_FULL.slice(0, 4);
const JPEG_SOI = [0xff, 0xd8, 0xff];
const GIF8 = [0x47, 0x49, 0x46, 0x38]; // "GIF8" — covers GIF87a and GIF89a
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP" fourCC at byte 8

function matchesAt(b: Uint8Array, sig: readonly number[], offset = 0, mask = 0xff): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if ((b[offset + i] & mask) !== sig[i]) return false;
  return true;
}

function isFormat(b: Uint8Array, format: ImageMagicFormat, opts: ImageSniffOptions): boolean {
  switch (format) {
    case 'jpeg':
      return matchesAt(b, JPEG_SOI);
    case 'png':
      return matchesAt(b, opts.pngSignature === 'full' ? PNG_FULL : PNG_PREFIX);
    case 'gif':
      return matchesAt(b, GIF8);
    case 'webp': {
      // RIFF alone is also WAV/AVI; the WEBP fourCC is what makes it an image.
      const mask = opts.webpFourCcIgnoresHighBit ? 0x7f : 0xff;
      return matchesAt(b, RIFF, 0, mask) && matchesAt(b, WEBP, 8, mask);
    }
  }
}

/** The caller-allowed format the bytes' signature matches, or null. Typed to the caller's own set. */
export function sniffImageFormat<F extends ImageMagicFormat>(
  bytes: Uint8Array,
  opts: ImageSniffOptions & { formats: readonly F[] }
): F | null {
  if (opts.minLength !== undefined && bytes.length < opts.minLength) return null;
  for (const format of opts.formats) {
    if (isFormat(bytes, format, opts)) return format;
  }
  return null;
}
