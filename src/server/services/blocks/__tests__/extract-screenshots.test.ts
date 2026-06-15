import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  detectImageType,
  extractScreenshots,
} from '../publish-request.service';
import {
  MAX_SCREENSHOTS,
  MAX_SCREENSHOT_SIZE_BYTES,
} from '~/server/schema/blocks/publish-request.schema';

/**
 * F-E E5 — security coverage for the bundle screenshot capture (publisher
 * images are an abuse vector). These tests pin the caps + validation so they
 * FAIL if any is removed (mutation-meaningful):
 *   - discovery of `screenshots/*` images
 *   - count cap (>N rejected, NOT truncated)
 *   - per-file size cap
 *   - real-image magic-byte validation (a `.png` that isn't a PNG → rejected)
 *   - path-traversal / sub-dir / odd-name rejection
 *   - "no screenshots dir → []"
 */

// --- minimal valid image byte sequences (real magic-byte signatures) ---------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
function pngBytes(extraBytes = 16): Buffer {
  return Buffer.concat([PNG_SIG, Buffer.alloc(extraBytes, 0x42)]);
}
function jpegBytes(extraBytes = 16): Buffer {
  return Buffer.concat([JPEG_SIG, Buffer.alloc(extraBytes, 0x42)]);
}
function webpBytes(payloadBytes = 16): Buffer {
  // "RIFF" <size:4> "WEBP" <payload>
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4, 0x00),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(payloadBytes, 0x42),
  ]);
}

async function makeBundle(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  // Always include a manifest so the bundle resembles a real one (not required
  // by extractScreenshots, but keeps the fixtures realistic).
  zip.file('block.manifest.json', JSON.stringify({ blockId: 'x', version: '0.1.0', name: 'X' }));
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('detectImageType (magic-byte validation)', () => {
  it('accepts real PNG/JPEG/WebP bytes for the matching extension', () => {
    expect(detectImageType(pngBytes(), 'png')).toBe('png');
    expect(detectImageType(jpegBytes(), 'jpg')).toBe('jpg');
    expect(detectImageType(jpegBytes(), 'jpeg')).toBe('jpg'); // jpeg normalises to jpg
    expect(detectImageType(webpBytes(), 'webp')).toBe('webp');
  });

  it('REJECTS bytes that do not match the claimed extension (extension is not trusted)', () => {
    // A real JPEG masquerading as .png → rejected.
    expect(detectImageType(jpegBytes(), 'png')).toBeNull();
    // A PNG claimed as .webp → rejected.
    expect(detectImageType(pngBytes(), 'webp')).toBeNull();
    // Arbitrary non-image bytes (e.g. an HTML/script payload) → rejected.
    expect(detectImageType(Buffer.from('<html>not an image</html>'), 'png')).toBeNull();
  });

  it('RIFF without the WEBP fourCC is not a webp (e.g. a WAV)', () => {
    const riffWav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4, 0),
      Buffer.from('WAVE', 'ascii'),
      Buffer.alloc(16, 0),
    ]);
    expect(detectImageType(riffWav, 'webp')).toBeNull();
  });
});

describe('extractScreenshots', () => {
  it('discovers screenshots/* images in deterministic index order', async () => {
    const buf = await makeBundle({
      'screenshots/b.png': pngBytes(),
      'screenshots/a.jpg': jpegBytes(),
      'screenshots/c.webp': webpBytes(),
      'index.html': '<!doctype html>',
    });
    const shots = await extractScreenshots(buf);
    expect(shots.map((s) => s.index)).toEqual([0, 1, 2]);
    // Sorted by path: a.jpg, b.png, c.webp.
    expect(shots.map((s) => s.ext)).toEqual(['jpg', 'png', 'webp']);
    expect(shots.map((s) => s.contentType)).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('returns [] when there is no screenshots/ directory', async () => {
    const buf = await makeBundle({ 'index.html': '<!doctype html>', 'app.js': 'x' });
    expect(await extractScreenshots(buf)).toEqual([]);
  });

  it('REJECTS more than MAX_SCREENSHOTS (count cap; not truncated)', async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i <= MAX_SCREENSHOTS; i += 1) {
      // MAX_SCREENSHOTS + 1 entries → must reject.
      files[`screenshots/shot-${String(i).padStart(2, '0')}.png`] = pngBytes();
    }
    const buf = await makeBundle(files);
    await expect(extractScreenshots(buf)).rejects.toThrow(
      new RegExp(`max ${MAX_SCREENSHOTS} screenshots`)
    );
  });

  it('accepts exactly MAX_SCREENSHOTS (boundary)', async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < MAX_SCREENSHOTS; i += 1) {
      files[`screenshots/shot-${String(i).padStart(2, '0')}.png`] = pngBytes();
    }
    const buf = await makeBundle(files);
    const shots = await extractScreenshots(buf);
    expect(shots.length).toBe(MAX_SCREENSHOTS);
  });

  it('REJECTS a screenshot over the per-file size cap', async () => {
    // Use a small injected cap so the fixture stays tiny but still exercises the
    // per-file bound. PNG sig + (cap) bytes = cap+8 > cap → reject.
    const cap = 1024;
    const big = Buffer.concat([PNG_SIG, Buffer.alloc(cap, 0x42)]);
    const buf = await makeBundle({ 'screenshots/big.png': big });
    await expect(
      extractScreenshots(buf, { maxScreenshotSizeBytes: cap })
    ).rejects.toThrow(/over \d+ bytes|max \d+ per screenshot/);
  });

  it('default per-file cap is enforced (MAX_SCREENSHOT_SIZE_BYTES)', async () => {
    // One byte over the real default cap → reject (without an injected cap).
    const big = Buffer.concat([PNG_SIG, Buffer.alloc(MAX_SCREENSHOT_SIZE_BYTES, 0x42)]);
    const buf = await makeBundle({ 'screenshots/big.png': big });
    await expect(extractScreenshots(buf)).rejects.toThrow(/over|max/);
  });

  it('REJECTS a .png whose bytes are NOT a real PNG (magic-byte validation)', async () => {
    const buf = await makeBundle({
      // Claims .png, but the bytes are a JPEG.
      'screenshots/fake.png': jpegBytes(),
    });
    await expect(extractScreenshots(buf)).rejects.toThrow(/not a valid PNG image/);
  });

  it('REJECTS a screenshot that is not an image at all (script payload as .webp)', async () => {
    const buf = await makeBundle({
      'screenshots/evil.webp': Buffer.from('<script>alert(1)</script>'),
    });
    await expect(extractScreenshots(buf)).rejects.toThrow(/not a valid WEBP image/);
  });

  it('REJECTS a sub-directory entry under screenshots/ (no nested paths)', async () => {
    const buf = await makeBundle({ 'screenshots/nested/a.png': pngBytes() });
    await expect(extractScreenshots(buf)).rejects.toThrow(/invalid screenshot filename/);
  });

  it('REJECTS a leading-dot / odd filename', async () => {
    const buf = await makeBundle({ 'screenshots/.hidden.png': pngBytes() });
    await expect(extractScreenshots(buf)).rejects.toThrow(/invalid screenshot filename/);
  });

  it('REJECTS a disallowed extension under screenshots/', async () => {
    const buf = await makeBundle({ 'screenshots/notes.svg': pngBytes() });
    await expect(extractScreenshots(buf)).rejects.toThrow(/must be one of/);
  });

  it('ignores a non-image file that is not under screenshots/', async () => {
    const buf = await makeBundle({
      'screenshots/ok.png': pngBytes(),
      'assets/logo.svg': '<svg></svg>',
      'README.md': '# hi',
    });
    const shots = await extractScreenshots(buf);
    expect(shots.length).toBe(1);
    expect(shots[0].ext).toBe('png');
  });
});
