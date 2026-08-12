/**
 * Build image containers that actually CARRY an EXIF orientation tag.
 *
 * Why this exists: `ListingAssetStep` prechecks the server's per-kind geometry
 * bounds on the pair `createImageBitmap` reports, and whether that pair matches
 * the server's depends entirely on EXIF orientation. Every other fixture in the
 * listing-asset suite is a fresh canvas raster, which carries no EXIF at all — so
 * a suite built only from those is STRUCTURALLY BLIND to the dimension the
 * precheck's correctness rests on (mutating the `imageOrientation` option left it
 * 34/34 green). These builders are what let a test observe that dimension.
 *
 * Both are pure byte surgery over an already-encoded image, so the same helper
 * serves the browser suite (raster from `canvas.toBlob`) and the node suite
 * (raster from `sharp`) — which is what lets ONE fixture be proven faithful to
 * BOTH readers: `stored-image-probe-exif-fixture.test.ts` asserts sharp reads
 * these exact containers the way the server's probe needs, and the browser suite
 * asserts what Chromium makes of them.
 */

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u24le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * The smallest legal little-endian TIFF block that says one thing: Orientation.
 * Header (8 bytes: "II", magic 42, offset-to-IFD0 = 8) + an IFD0 holding exactly
 * one 12-byte entry (tag 0x0112, type SHORT, count 1, value inline) + a null
 * next-IFD pointer.
 */
function tiffOrientation(orientation: number): Uint8Array {
  return Uint8Array.from([
    ...ascii('II'),
    0x2a,
    0x00,
    ...u32le(8),
    // IFD0: one entry.
    0x01,
    0x00,
    // tag 0x0112 = Orientation, type 3 = SHORT, count 1.
    0x12,
    0x01,
    0x03,
    0x00,
    ...u32le(1),
    // A SHORT occupies the first 2 of the entry's 4 value bytes.
    orientation & 0xff,
    0x00,
    0x00,
    0x00,
    // No next IFD.
    ...u32le(0),
  ]);
}

/** One RIFF chunk: FourCC + LE payload length + payload, padded to even. */
function riffChunk(fourCC: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  out.set(ascii(fourCC), 0);
  out.set(u32le(payload.length), 4);
  out.set(payload, 8);
  return out;
}

/** The VP8X flags bit that declares "this file carries an EXIF chunk". */
const VP8X_EXIF_FLAG = 0x08;

/**
 * Re-wrap an encoded WebP as an EXTENDED WebP carrying an EXIF chunk: a leading
 * `VP8X` chunk whose flags byte has bit 0x08 set, the original image data, and
 * the `EXIF` chunk last.
 *
 * 🔴 The two encoders this suite uses do NOT agree on the input shape, and
 * getting that wrong produces a file no decoder will touch rather than a wrong
 * answer. `sharp().webp()` emits the simple form (`VP8 ` alone), so a `VP8X` has
 * to be synthesised; Chromium's `canvas.toBlob('image/webp')` ALREADY emits an
 * extended file (`VP8X` + `ICCP` + `VP8 `), and prepending a second `VP8X` to
 * that made every `createImageBitmap` call fail `InvalidStateError`. So: reuse
 * an existing `VP8X` and just set its EXIF bit; synthesise one only when there
 * is none.
 *
 * `width`/`height` are the STORED raster's — what the encoder was handed. They
 * are used only for a synthesised `VP8X`; a reader honouring the orientation
 * reports them transposed either way.
 */
export function webpWithExifOrientation(
  webp: Uint8Array,
  width: number,
  height: number,
  orientation: number
): Uint8Array {
  if (String.fromCharCode(...webp.subarray(0, 4)) !== 'RIFF') throw new Error('not a RIFF file');
  if (String.fromCharCode(...webp.subarray(8, 12)) !== 'WEBP') throw new Error('not a WebP file');
  // Everything after the 12-byte RIFF/WEBP preamble is the existing chunk list.
  const rest = webp.subarray(12);
  const hasVp8x = String.fromCharCode(...rest.subarray(0, 4)) === 'VP8X';
  let head: Uint8Array;
  if (hasVp8x) {
    head = Uint8Array.from(rest);
    // Byte 8 is the first byte of the VP8X payload: the flags.
    head[8] |= VP8X_EXIF_FLAG;
  } else {
    const vp8x = riffChunk(
      'VP8X',
      Uint8Array.from([VP8X_EXIF_FLAG, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])
    );
    head = new Uint8Array(vp8x.length + rest.length);
    head.set(vp8x, 0);
    head.set(rest, vp8x.length);
  }
  const exif = riffChunk('EXIF', tiffOrientation(orientation));
  const body = new Uint8Array(head.length + exif.length);
  body.set(head, 0);
  body.set(exif, head.length);
  const out = new Uint8Array(12 + body.length);
  out.set(ascii('RIFF'), 0);
  out.set(u32le(4 + body.length), 4);
  out.set(ascii('WEBP'), 8);
  out.set(body, 12);
  return out;
}

/**
 * Splice an EXIF `APP1` segment in immediately after the JPEG `SOI`, which is
 * where every EXIF reader looks for it.
 */
export function jpegWithExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG file');
  const tiff = tiffOrientation(orientation);
  // Segment length counts its own 2 bytes + the "Exif\0\0" introducer + the TIFF.
  const len = 2 + 6 + tiff.length;
  const app1 = Uint8Array.from([
    0xff,
    0xe1,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...ascii('Exif'),
    0,
    0,
    ...tiff,
  ]);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}
