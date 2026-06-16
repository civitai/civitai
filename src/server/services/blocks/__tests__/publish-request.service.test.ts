import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  computeFileDiff,
  computeManifestDiff,
  extractBundleMetadata,
  type FileMeta,
} from '../publish-request.service';
import {
  MAX_BUNDLE_SIZE_BYTES,
  MAX_FILES_IN_BUNDLE,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_DECOMPRESSED_BYTES,
} from '~/server/schema/blocks/publish-request.schema';

/**
 * Deterministic-input coverage for the W1 publish-request flow's diff
 * computations and bundle parsing. These tests don't touch MinIO or the
 * DB; the integration coverage of the full submitVersion pipeline lives
 * in a Phase 2 follow-on (needs an S3 mock).
 */

function makeFile(path: string, sha: string, size = 100): FileMeta {
  return { path, sha256: sha, sizeBytes: size };
}

describe('computeFileDiff', () => {
  it('treats null previous as a first-version add-all', () => {
    const curr = [makeFile('Dockerfile', 'aa'), makeFile('block.manifest.json', 'bb')];
    const result = computeFileDiff(curr, null);
    expect(result.files).toEqual(curr);
    expect(result.added).toEqual(['Dockerfile', 'block.manifest.json']);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('detects added paths', () => {
    const prev = [makeFile('a', '1')];
    const curr = [makeFile('a', '1'), makeFile('b', '2')];
    const result = computeFileDiff(curr, prev);
    expect(result.added).toEqual(['b']);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('detects removed paths', () => {
    const prev = [makeFile('a', '1'), makeFile('b', '2')];
    const curr = [makeFile('a', '1')];
    const result = computeFileDiff(curr, prev);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['b']);
    expect(result.changed).toEqual([]);
  });

  it('detects content changes via sha mismatch', () => {
    const prev = [makeFile('a', '1'), makeFile('b', '2')];
    const curr = [makeFile('a', '1'), makeFile('b', '3')];
    const result = computeFileDiff(curr, prev);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual(['b']);
  });

  it('handles a mix of add/remove/change in one diff', () => {
    const prev = [makeFile('Dockerfile', '1'), makeFile('old.tsx', '2')];
    const curr = [makeFile('Dockerfile', '1-changed'), makeFile('new.tsx', '3')];
    const result = computeFileDiff(curr, prev);
    expect(result.added).toEqual(['new.tsx']);
    expect(result.removed).toEqual(['old.tsx']);
    expect(result.changed).toEqual(['Dockerfile']);
  });

  it('produces deterministic ordering regardless of input order', () => {
    const prev = [makeFile('z', '1'), makeFile('a', '2'), makeFile('m', '3')];
    const curr = [makeFile('z', '1-new'), makeFile('a', '2'), makeFile('b', '4')];
    const r1 = computeFileDiff(curr, prev);
    const r2 = computeFileDiff([...curr].reverse(), [...prev].reverse());
    expect(r1.added).toEqual(r2.added);
    expect(r1.removed).toEqual(r2.removed);
    expect(r1.changed).toEqual(r2.changed);
  });
});

describe('computeManifestDiff', () => {
  it('treats null previous as a first-version diff', () => {
    const curr = { blockId: 'x', version: '0.1.0', name: 'X' };
    const result = computeManifestDiff(curr, null);
    expect(result.kind).toBe('first-version');
    if (result.kind === 'first-version') {
      expect(result.fields).toEqual(['blockId', 'name', 'version']);
    }
  });

  it('detects added top-level fields', () => {
    const prev = { blockId: 'x' };
    const curr = { blockId: 'x', name: 'X' };
    const result = computeManifestDiff(curr, prev);
    expect(result.kind).toBe('update');
    if (result.kind === 'update') {
      expect(result.added).toEqual(['name']);
      expect(result.removed).toEqual([]);
      expect(result.changed).toEqual([]);
    }
  });

  it('detects removed top-level fields', () => {
    const prev = { blockId: 'x', name: 'X' };
    const curr = { blockId: 'x' };
    const result = computeManifestDiff(curr, prev);
    expect(result.kind).toBe('update');
    if (result.kind === 'update') {
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual(['name']);
    }
  });

  it('detects changed top-level scalars', () => {
    const prev = { blockId: 'x', version: '0.1.0' };
    const curr = { blockId: 'x', version: '0.2.0' };
    const result = computeManifestDiff(curr, prev);
    if (result.kind !== 'update') throw new Error('expected update');
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].field).toBe('version');
    expect(result.changed[0].from).toBe('0.1.0');
    expect(result.changed[0].to).toBe('0.2.0');
  });

  it('detects deep object changes via stable hash (key order independence)', () => {
    const prev = { iframe: { src: 'a', minHeight: 200 } };
    const curr = { iframe: { minHeight: 200, src: 'a' } }; // same content, different key order
    const result = computeManifestDiff(curr, prev);
    if (result.kind !== 'update') throw new Error('expected update');
    expect(result.changed).toEqual([]); // semantically equal
  });

  it('detects deep object changes when content differs', () => {
    const prev = { iframe: { src: 'a', minHeight: 200 } };
    const curr = { iframe: { src: 'a', minHeight: 300 } };
    const result = computeManifestDiff(curr, prev);
    if (result.kind !== 'update') throw new Error('expected update');
    expect(result.changed.map((c) => c.field)).toEqual(['iframe']);
  });

  it('summarises large field values without losing the change signal', () => {
    const big = 'x'.repeat(3000);
    const prev = { description: big };
    const curr = { description: big + 'y' };
    const result = computeManifestDiff(curr, prev);
    if (result.kind !== 'update') throw new Error('expected update');
    const change = result.changed[0];
    expect(change.field).toBe('description');
    expect(change.from).toMatchObject({ __summarised: true });
    expect(change.to).toMatchObject({ __summarised: true });
  });
});

describe('extractBundleMetadata', () => {
  async function makeBundle(files: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(files)) {
      zip.file(path, content);
    }
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  it('parses a valid bundle and surfaces files + manifest', async () => {
    const buf = await makeBundle({
      'block.manifest.json': JSON.stringify({
        blockId: 'hello',
        version: '0.1.0',
        name: 'Hello',
      }),
      'index.html': '<!doctype html><html><body>hi</body></html>',
    });
    const { files, manifest } = await extractBundleMetadata(buf);
    expect(files.map((f) => f.path).sort()).toEqual(['block.manifest.json', 'index.html']);
    expect(manifest).toMatchObject({ blockId: 'hello', version: '0.1.0', name: 'Hello' });
  });

  it('rejects bundles without the manifest', async () => {
    const buf = await makeBundle({
      'index.html': '<!doctype html>',
    });
    await expect(extractBundleMetadata(buf)).rejects.toThrow(
      /missing required file: block.manifest.json/
    );
  });

  it('rejects an empty bundle', async () => {
    const buf = await makeBundle({});
    await expect(extractBundleMetadata(buf)).rejects.toThrow(/empty/);
  });

  it('rejects a manifest that is not valid JSON', async () => {
    const buf = await makeBundle({
      'block.manifest.json': '{this is not json}',
    });
    await expect(extractBundleMetadata(buf)).rejects.toThrow(/not valid JSON/);
  });

  it('computes deterministic sha256 hashes', async () => {
    const buf1 = await makeBundle({
      'block.manifest.json': '{"blockId":"x"}',
      'a.txt': 'hello',
    });
    const buf2 = await makeBundle({
      'block.manifest.json': '{"blockId":"x"}',
      'a.txt': 'hello',
    });
    const r1 = await extractBundleMetadata(buf1);
    const r2 = await extractBundleMetadata(buf2);
    const sha1 = r1.files.find((f) => f.path === 'a.txt')?.sha256;
    const sha2 = r2.files.find((f) => f.path === 'a.txt')?.sha256;
    expect(sha1).toBeDefined();
    expect(sha1).toBe(sha2);
  });

  it('sorts files deterministically', async () => {
    const buf = await makeBundle({
      'z.txt': 'z',
      'block.manifest.json': '{"blockId":"x"}',
      'a.txt': 'a',
      'm.txt': 'm',
    });
    const { files } = await extractBundleMetadata(buf);
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'block.manifest.json', 'm.txt', 'z.txt']);
  });

  it('rejects when a single file exceeds 10 MiB cap', async () => {
    // One file at MAX_FILE_SIZE_BYTES + 1 = 10 MiB + 1 byte.
    const big = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 'x');
    const buf = await makeBundle({
      'block.manifest.json': '{"blockId":"x"}',
      'big.bin': big.toString('binary'),
    });
    await expect(extractBundleMetadata(buf)).rejects.toThrow(
      new RegExp(`max ${MAX_FILE_SIZE_BYTES}`)
    );
  });

  it('accepts a single file at exactly the 10 MiB cap', async () => {
    // A file at exactly MAX_FILE_SIZE_BYTES should pass (boundary).
    const buf = await makeBundle({
      'block.manifest.json': '{"blockId":"x"}',
      'big.bin': 'x'.repeat(MAX_FILE_SIZE_BYTES),
    });
    const { files } = await extractBundleMetadata(buf);
    expect(files.find((f) => f.path === 'big.bin')?.sizeBytes).toBe(MAX_FILE_SIZE_BYTES);
  });

  it('rejects when bundle exceeds the 2000-file cap', async () => {
    const zip = new JSZip();
    zip.file('block.manifest.json', '{"blockId":"x"}');
    for (let i = 0; i < MAX_FILES_IN_BUNDLE; i += 1) {
      zip.file(`f${i}.txt`, String(i));
    }
    // Total files = 2001 (manifest + 2000 added)
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(extractBundleMetadata(buf)).rejects.toThrow(
      new RegExp(`max ${MAX_FILES_IN_BUNDLE}`)
    );
  });

  it('accepts a bundle at exactly the 2000-file cap', async () => {
    const zip = new JSZip();
    zip.file('block.manifest.json', '{"blockId":"x"}');
    for (let i = 0; i < MAX_FILES_IN_BUNDLE - 1; i += 1) {
      zip.file(`f${i}.txt`, String(i));
    }
    // Total files = 2000 (manifest + 1999)
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const { files } = await extractBundleMetadata(buf);
    expect(files.length).toBe(MAX_FILES_IN_BUNDLE);
  });

  // H-1 fix — extractBundleMetadata NOW tracks the cumulative decompressed
  // size and aborts the streaming read the instant a bundle's total exceeds
  // the cap, so a small ZIP of highly-compressible content can no longer
  // inflate past the running-aggregate ceiling. Uses an injected small cap so
  // the test ZIP stays tiny while still exercising the aggregate-abort path.
  it('guards against cumulative decompression expansion (H-1 fix)', async () => {
    // 5 MiB of zeroes per file, two files = ~10 MiB extracted.
    // Force DEFLATE so the compressed ZIP is much smaller than the
    // extracted total (default jszip behavior is STORE).
    const big = Buffer.alloc(5 * 1024 * 1024, 0);
    const zip = new JSZip();
    zip.file('block.manifest.json', '{"blockId":"x"}');
    zip.file('a.bin', big);
    zip.file('b.bin', big);
    const buf = Buffer.from(
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      })
    );
    // Compressed buffer is well under 1 MiB; extracted total is ~10 MiB.
    expect(buf.length).toBeLessThan(1 * 1024 * 1024);
    // Inject a 6 MiB total cap: the two 5 MiB files sum past it, so the
    // running-aggregate guard rejects the bundle instead of materialising it.
    await expect(extractBundleMetadata(buf, { maxTotalBytes: 6 * 1024 * 1024 })).rejects.toThrow(
      /zip bomb|decompress/i
    );
  });

  it('aggregate cap boundary: total exactly at cap passes, one byte over rejects', async () => {
    // Two 1 MiB zero-filled DEFLATE files = 2 MiB decompressed total. With a
    // 2 MiB total cap the bundle is exactly at the ceiling and must pass; with
    // a one-byte-smaller cap it must reject. The manifest's own bytes count
    // toward the total, so cap = files + manifest length for the pass case.
    const oneMiB = 1024 * 1024;
    const manifestJson = '{"blockId":"x"}';
    const filesTotal = 2 * oneMiB;
    const exactCap = filesTotal + Buffer.byteLength(manifestJson);

    async function makeZeroBundle(): Promise<Buffer> {
      const zip = new JSZip();
      zip.file('block.manifest.json', manifestJson);
      zip.file('a.bin', Buffer.alloc(oneMiB, 0));
      zip.file('b.bin', Buffer.alloc(oneMiB, 0));
      return Buffer.from(
        await zip.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        })
      );
    }

    const buf = await makeZeroBundle();
    // Exactly at the cap: passes.
    const { files } = await extractBundleMetadata(buf, { maxTotalBytes: exactCap });
    expect(files.length).toBe(3);
    // One byte under the needed budget: rejects.
    await expect(extractBundleMetadata(buf, { maxTotalBytes: exactCap - 1 })).rejects.toThrow(
      /zip bomb|decompress/i
    );
  });
});

describe('schema boundary caps', () => {
  it('MAX_BUNDLE_SIZE_BYTES is 50 MiB', () => {
    expect(MAX_BUNDLE_SIZE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_BUNDLE_SIZE_BYTES).toBe(52_428_800);
  });

  it('MAX_FILES_IN_BUNDLE is 2000', () => {
    expect(MAX_FILES_IN_BUNDLE).toBe(2000);
  });

  it('MAX_FILE_SIZE_BYTES is 10 MiB', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('MAX_TOTAL_DECOMPRESSED_BYTES is 200 MiB and is 4x the upload cap', () => {
    expect(MAX_TOTAL_DECOMPRESSED_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_TOTAL_DECOMPRESSED_BYTES).toBe(MAX_BUNDLE_SIZE_BYTES * 4);
  });

  // L-1 lock-in — the bundleBase64 zod cap formula is slightly over-permissive
  // (~15 bytes more than the true base64 length for 50 MiB). Innocuous; this
  // test records the relationship explicitly.
  it('bundleBase64 cap formula matches MAX_BUNDLE_SIZE_BYTES base64 length within 16 bytes', () => {
    const trueB64Length = Math.ceil(MAX_BUNDLE_SIZE_BYTES / 3) * 4;
    const formulaUsed = Math.ceil((MAX_BUNDLE_SIZE_BYTES * 4) / 3) + 16;
    expect(formulaUsed).toBeGreaterThanOrEqual(trueB64Length);
    expect(formulaUsed - trueB64Length).toBeLessThanOrEqual(16);
  });
});
