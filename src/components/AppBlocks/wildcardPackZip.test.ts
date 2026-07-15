import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseWildcardZip, readEntryBounded } from './wildcardPackHost';
import { WILDCARD_PACK_CAPS } from './wildcardPackParse';

// Real end-to-end zip tests: build a zip with JSZip, then run the ACTUAL
// jszip-backed `parseWildcardZip` (bounded, streamed inflate) against it. Node-
// safe (no fetch), so the anti-zip-bomb bounds are verified against a real
// deflate bomb — the security test #3130 lacked.

async function makeZip(files: Record<string, string>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression });
}

describe('parseWildcardZip — real zips', () => {
  it('parses txt + yaml entries into named lists', async () => {
    const bytes = await makeZip({
      'colors.txt': '# palette\nred\nblue\nred\n#ffffff',
      'nouns.yaml': 'animals:\n  - cat\n  - dog\nclothing:\n  tops:\n    - shirt',
    });
    const { lists, truncated } = await parseWildcardZip(bytes);
    expect(lists).toEqual({
      colors: ['red', 'blue', '#ffffff'],
      animals: ['cat', 'dog'],
      'clothing/tops': ['shirt'],
    });
    expect(truncated).toBe(false);
  });

  it('skips preview images + dotfiles, yielding only the list files', async () => {
    const bytes = await makeZip({
      'colors.txt': 'red\nblue',
      'preview.png': 'not really a png but classified by extension',
      '.DS_Store': 'junk',
      '__MACOSX/colors.txt': 'should-be-ignored',
    });
    const { lists } = await parseWildcardZip(bytes);
    expect(lists).toEqual({ colors: ['red', 'blue'] });
  });

  it('an images-only zip → empty lists (not an error)', async () => {
    const bytes = await makeZip({ 'a.png': 'x', 'b.jpg': 'y' });
    const { lists, truncated } = await parseWildcardZip(bytes);
    expect(lists).toEqual({});
    expect(truncated).toBe(false);
  });

  it('BOUNDS inflation of a real deflate bomb — never fully inflates the entry', async () => {
    // 8 MB of a single repeated byte → deflates to a few KB. With a 1 MB
    // per-entry cap, the bounded read must inflate only ~1 MB, NOT 8 MB.
    const bombText = 'A'.repeat(8 * 1024 * 1024);
    const zip = new JSZip();
    zip.file('bomb.txt', bombText);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    const zip2 = await JSZip.loadAsync(bytes);
    const file = zip2.files['bomb.txt'];
    const limit = WILDCARD_PACK_CAPS.perEntryBytes; // 1 MB
    const { bytes: inflated, hitLimit } = await readEntryBounded(file, limit);
    expect(hitLimit).toBe(true);
    // Bounded to ~limit + one decompression block — decisively NOT the 8 MB total.
    expect(inflated).toBeGreaterThanOrEqual(limit);
    expect(inflated).toBeLessThan(limit + 256 * 1024);
    expect(inflated).toBeLessThan(bombText.length);
  });

  it('a bomb inside parseWildcardZip is SKIPPED by the declared-size belt + flags truncated', async () => {
    const bombText = 'A'.repeat(4 * 1024 * 1024); // 4 MB > 1 MB per-entry cap
    const bytes = await makeZip({ 'bomb.txt': bombText, 'ok.txt': 'red\nblue' });
    const { lists, truncated } = await parseWildcardZip(bytes);
    // A real zip carries the uncompressed size in its central directory, so the
    // declared-size belt skips bomb.txt entirely WITHOUT inflating a byte of it —
    // the strongest outcome. The OTHER list still parses; the pack is truncated.
    expect(truncated).toBe(true);
    expect(lists.ok).toEqual(['red', 'blue']);
    expect(lists.bomb).toBeUndefined();
  });

  it('enforces the 16 MB TOTAL uncompressed budget across many entries', async () => {
    // 20 entries × ~1 MB each = ~20 MB uncompressed, over the 16 MB total cap.
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = 'A'.repeat(1024 * 1024);
    const bytes = await makeZip(files);
    const { lists, truncated } = await parseWildcardZip(bytes);
    expect(truncated).toBe(true);
    // Not all 20 lists survive — the loop stops once the total budget is spent.
    expect(Object.keys(lists).length).toBeLessThan(20);
  });

  it('a corrupt / non-zip buffer rejects (loadAsync throws)', async () => {
    await expect(parseWildcardZip(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeTruthy();
  });
});
