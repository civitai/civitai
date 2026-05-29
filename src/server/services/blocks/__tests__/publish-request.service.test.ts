import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  computeFileDiff,
  computeManifestDiff,
  extractBundleMetadata,
  type FileMeta,
} from '../publish-request.service';

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
    const curr = [
      makeFile('Dockerfile', '1-changed'),
      makeFile('new.tsx', '3'),
    ];
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
    const curr = { iframe: { minHeight: 200, src: 'a' } };  // same content, different key order
    const result = computeManifestDiff(curr, prev);
    if (result.kind !== 'update') throw new Error('expected update');
    expect(result.changed).toEqual([]);  // semantically equal
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
    await expect(extractBundleMetadata(buf)).rejects.toThrow(/missing required file: block.manifest.json/);
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
    expect(files.map((f) => f.path)).toEqual([
      'a.txt',
      'block.manifest.json',
      'm.txt',
      'z.txt',
    ]);
  });
});
