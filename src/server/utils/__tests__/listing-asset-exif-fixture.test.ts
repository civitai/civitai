import { describe, expect, test } from 'vitest';
import sharp from 'sharp';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import {
  jpegWithExifOrientation,
  webpWithExifOrientation,
} from '../../../../test/fixtures/exif-image';

/**
 * The listing-asset browser suite proves its EXIF claims against CHROMIUM. This
 * proves the other half — that those same fixtures are what the SERVER thinks
 * they are — because the whole point of the WebP case is that the two readers
 * DISAGREE, and a disagreement is only evidence if both sides were measured.
 *
 * Without this, a hand-built container that simply carried no readable EXIF would
 * make the browser assertion pass for the wrong reason: the browser would report
 * the stored pair (as it does for a real EXIF WebP), the fixture would look like
 * it reproduced the bug, and nothing would have shown that the server ever saw an
 * orientation at all. That is the failure this file exists to make impossible.
 *
 * Scope is deliberately ONE claim: that these fixtures' BYTES carry a readable
 * EXIF orientation, i.e. the two INPUTS `probeStoredImage` consumes —
 * `sharp().metadata()`'s stored dimensions and its `orientation`.
 *
 * 🔴 It stops there on purpose. An earlier revision also asserted what the server
 * MAKES of those inputs, using a local helper that re-stated `probeStoredImage`'s
 * orientation-5–8 transposition — a vendored copy of a rule, which is the exact
 * anti-pattern this PR exists to remove (civitai/cli#270): it agrees with itself
 * whatever the real function does, so it could not detect the two diverging. The
 * rule is now EXECUTED instead, by `persistListingAssetImage` running end to end
 * against the real `probeStoredImage` in
 * `src/server/services/blocks/__tests__/offsite-listing.service.test.ts`
 * ("reports a quarter-turned JPEG/WEBP the way a renderer shows it").
 *
 * Runs in the `unit` project, which keeps the real `sharp`.
 */

/** A solid raster of a known STORED size, in the container under test. */
async function raster(format: 'webp' | 'jpeg', width: number, height: number) {
  const img = sharp({ create: { width, height, channels: 3, background: '#4488cc' } });
  const buf = format === 'webp' ? await img.webp().toBuffer() : await img.jpeg().toBuffer();
  return new Uint8Array(buf);
}

describe('EXIF fixture builders are faithful to the server-side reader', () => {
  test('webpWithExifOrientation produces a WebP sharp reads as quarter-turned', async () => {
    const bytes = webpWithExifOrientation(await raster('webp', 640, 1280), 640, 1280, 6);

    const meta = await sharp(Buffer.from(bytes)).metadata();

    expect(meta.format).toBe('webp');
    // The raster is unchanged — only the container gained an EXIF chunk.
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 640, height: 1280 });
    // 🔴 The load-bearing assertion: the orientation actually survives the byte
    // surgery and is READ. A builder that produced a malformed EXIF chunk would
    // leave this undefined, and the browser-side WebP test would then be asserting
    // nothing about a disagreement.
    expect(meta.orientation).toBe(6);
    // …which is what makes the server measure a LANDSCAPE 1280×640 (cover aspect
    // 2.00) from bytes Chromium reports as a portrait 640×1280 (aspect 0.50). That
    // inversion is the entire regression the client-side sniff exists to avoid, and
    // the consequence is asserted where the real transposition RUNS — see the header.
  });

  test('jpegWithExifOrientation produces a JPEG sharp reads as quarter-turned', async () => {
    const bytes = jpegWithExifOrientation(await raster('jpeg', 640, 1280), 6);

    const meta = await sharp(Buffer.from(bytes)).metadata();

    expect(meta.format).toBe('jpeg');
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 640, height: 1280 });
    expect(meta.orientation).toBe(6);
    // Same stored pair and same orientation as the WebP above — which is what makes
    // the JPEG the CONTROL: the browser agrees here and disagrees there, so the two
    // fixtures differ in exactly one variable, the container.
  });

  test('an untouched raster carries no orientation (the builders are what add it)', async () => {
    // The negative control for both assertions above: if `orientation` were somehow
    // truthy on a plain encode, `toBe(6)` would be evidence about sharp's defaults
    // rather than about the builder.
    for (const format of ['webp', 'jpeg'] as const) {
      const meta = await sharp(Buffer.from(await raster(format, 640, 1280))).metadata();
      expect(meta.orientation).toBeUndefined();
      expect({ width: meta.width, height: meta.height }).toEqual({ width: 640, height: 1280 });
    }
  });
});
