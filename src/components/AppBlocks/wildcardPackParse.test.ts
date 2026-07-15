import { describe, expect, it } from 'vitest';
import {
  classifyWildcardEntry,
  classifyWildcardPackError,
  exceedsPreDownloadCap,
  extractTxtOptions,
  finalizeOptions,
  flattenYamlLists,
  isTxtCommentLine,
  PRE_DOWNLOAD_MAX_BYTES,
  processWildcardEntries,
  resolveGetWildcardPackRequest,
  wildcardPackError,
  WILDCARD_PACK_CAPS,
  type RawZipEntry,
} from './wildcardPackParse';

// A yaml parser stand-in for the pure processWildcardEntries tests — JSON is a
// yaml subset, so parsing JSON text exercises the same map/array/scalar flatten
// without dragging js-yaml into this pure suite.
const jsonYaml = (text: string) => JSON.parse(text);

// Build a mock RawZipEntry whose bounded `read` records the limit it was called
// with and returns `bytes`/`hitLimit` under test control. `read` THROWS if the
// entry should never be inflated (declared-size skip / classifier skip).
function entry(
  path: string,
  opts: {
    text?: string;
    bytes?: number;
    hitLimit?: boolean;
    declaredSize?: number | null;
    onRead?: (limit: number) => void;
    failRead?: boolean;
  } = {}
): RawZipEntry {
  return {
    path,
    declaredSize: opts.declaredSize ?? null,
    read: async (limit: number) => {
      opts.onRead?.(limit);
      if (opts.failRead) throw new Error('unreadable');
      const text = opts.text ?? '';
      return {
        text,
        bytes: opts.bytes ?? text.length,
        hitLimit: opts.hitLimit ?? false,
      };
    },
  };
}

describe('resolveGetWildcardPackRequest', () => {
  it('accepts a valid { requestId, modelVersionId }', () => {
    expect(resolveGetWildcardPackRequest({ requestId: 'rq', modelVersionId: 42 })).toEqual({
      requestId: 'rq',
      modelVersionId: 42,
    });
  });
  it('coerces a string modelVersionId', () => {
    expect(resolveGetWildcardPackRequest({ requestId: 'rq', modelVersionId: '42' })).toEqual({
      requestId: 'rq',
      modelVersionId: 42,
    });
  });
  it('drops missing/empty requestId', () => {
    expect(resolveGetWildcardPackRequest({ modelVersionId: 42 })).toBeNull();
    expect(resolveGetWildcardPackRequest({ requestId: '', modelVersionId: 42 })).toBeNull();
  });
  it('drops non-positive / non-integer modelVersionId', () => {
    expect(resolveGetWildcardPackRequest({ requestId: 'rq', modelVersionId: 0 })).toBeNull();
    expect(resolveGetWildcardPackRequest({ requestId: 'rq', modelVersionId: -5 })).toBeNull();
    expect(resolveGetWildcardPackRequest({ requestId: 'rq', modelVersionId: 1.5 })).toBeNull();
    expect(resolveGetWildcardPackRequest({ requestId: 'rq', modelVersionId: 'x' })).toBeNull();
  });
  it('drops non-objects', () => {
    expect(resolveGetWildcardPackRequest(null)).toBeNull();
    expect(resolveGetWildcardPackRequest('str')).toBeNull();
  });
});

describe('exceedsPreDownloadCap', () => {
  it('is false at/under the 32 MB cap, true above', () => {
    expect(exceedsPreDownloadCap(PRE_DOWNLOAD_MAX_BYTES)).toBe(false);
    expect(exceedsPreDownloadCap(PRE_DOWNLOAD_MAX_BYTES + 1)).toBe(true);
    expect(exceedsPreDownloadCap(0)).toBe(false);
  });
  it('is false for non-finite / non-number', () => {
    expect(exceedsPreDownloadCap(NaN)).toBe(false);
    expect(exceedsPreDownloadCap(undefined)).toBe(false);
    expect(exceedsPreDownloadCap('big')).toBe(false);
  });
});

describe('classifyWildcardPackError', () => {
  it('maps a host-tagged error', () => {
    expect(classifyWildcardPackError(wildcardPackError('too-large'))).toBe('too-large');
    expect(classifyWildcardPackError(wildcardPackError('parse-failed'))).toBe('parse-failed');
    expect(classifyWildcardPackError(wildcardPackError('busy'))).toBe('busy');
  });
  it('maps a tRPC client error data.code', () => {
    expect(classifyWildcardPackError({ data: { code: 'NOT_FOUND' } })).toBe('not-found');
    expect(classifyWildcardPackError({ data: { code: 'FORBIDDEN' } })).toBe('forbidden');
    expect(classifyWildcardPackError({ data: { code: 'PAYLOAD_TOO_LARGE' } })).toBe('too-large');
  });
  it('defaults unknown / network / abort errors to parse-failed', () => {
    expect(classifyWildcardPackError(new Error('boom'))).toBe('parse-failed');
    expect(classifyWildcardPackError({ name: 'AbortError' })).toBe('parse-failed');
    expect(classifyWildcardPackError(undefined)).toBe('parse-failed');
  });
});

describe('classifyWildcardEntry', () => {
  it('classifies txt / yaml / yml', () => {
    expect(classifyWildcardEntry('colors.txt')).toBe('txt');
    expect(classifyWildcardEntry('dir/sub/nouns.YAML')).toBe('yaml');
    expect(classifyWildcardEntry('a.yml')).toBe('yaml');
  });
  it('skips images, nested zips, dotfiles, __MACOSX', () => {
    expect(classifyWildcardEntry('preview.png')).toBe('skip');
    expect(classifyWildcardEntry('cover.jpeg')).toBe('skip');
    expect(classifyWildcardEntry('bundle.zip')).toBe('skip');
    expect(classifyWildcardEntry('.DS_Store')).toBe('skip');
    expect(classifyWildcardEntry('sub/.gitignore')).toBe('skip');
    expect(classifyWildcardEntry('__MACOSX/colors.txt')).toBe('skip');
    expect(classifyWildcardEntry('dir/._colors.txt')).toBe('skip');
  });
});

describe('isTxtCommentLine + extractTxtOptions', () => {
  it('treats "# ..." and a bare "#" as comments', () => {
    expect(isTxtCommentLine('# a comment')).toBe(true);
    expect(isTxtCommentLine('#')).toBe(true);
  });
  it('does NOT treat a hex-color value "#ffffff" as a comment (the #3130 fix)', () => {
    expect(isTxtCommentLine('#ffffff')).toBe(false);
    expect(isTxtCommentLine('#00ff00')).toBe(false);
  });
  it('strips comment + blank lines, trims, handles CRLF, keeps #ffffff', () => {
    const text = ['# palette', '', '  red  ', '#ffffff\r', 'blue', '   ', '# trailing note'].join(
      '\n'
    );
    expect(extractTxtOptions(text)).toEqual(['red', '#ffffff', 'blue']);
  });
});

describe('finalizeOptions (dedupe + caps)', () => {
  it('dedupes preserving first-occurrence order', () => {
    const { options, truncated } = finalizeOptions(['a', 'b', 'a', 'c', 'b'], WILDCARD_PACK_CAPS);
    expect(options).toEqual(['a', 'b', 'c']);
    expect(truncated).toBe(false);
  });
  it('truncates over-length options to maxCharsPerOption + flags', () => {
    const long = 'x'.repeat(WILDCARD_PACK_CAPS.maxCharsPerOption + 50);
    const { options, truncated } = finalizeOptions([long], WILDCARD_PACK_CAPS);
    expect(options[0]).toHaveLength(WILDCARD_PACK_CAPS.maxCharsPerOption);
    expect(truncated).toBe(true);
  });
  it('caps option count at maxOptionsPerList + flags', () => {
    const many = Array.from({ length: WILDCARD_PACK_CAPS.maxOptionsPerList + 100 }, (_, i) => `o${i}`);
    const { options, truncated } = finalizeOptions(many, WILDCARD_PACK_CAPS);
    expect(options).toHaveLength(WILDCARD_PACK_CAPS.maxOptionsPerList);
    expect(truncated).toBe(true);
  });
});

describe('flattenYamlLists', () => {
  it('flattens nested maps to parent/child names', () => {
    const parsed = {
      colors: ['red', 'blue'],
      clothing: { tops: ['shirt', 'blouse'], bottoms: ['jeans'] },
    };
    const lists = flattenYamlLists(parsed);
    expect(lists).toEqual([
      { name: 'colors', options: ['red', 'blue'] },
      { name: 'clothing/tops', options: ['shirt', 'blouse'] },
      { name: 'clothing/bottoms', options: ['jeans'] },
    ]);
  });
  it('coerces scalar leaves to a one-element list and trims', () => {
    expect(flattenYamlLists({ mood: '  happy  ' })).toEqual([{ name: 'mood', options: ['happy'] }]);
  });
  it('is first-write-wins on a case-insensitive name collision', () => {
    // Two sibling keys differing only in case collide → the first wins.
    const parsed = { Colors: ['red'], colors: ['blue'] };
    const lists = flattenYamlLists(parsed);
    expect(lists).toEqual([{ name: 'Colors', options: ['red'] }]);
  });
  it('tolerates a non-object root (returns [])', () => {
    expect(flattenYamlLists(null)).toEqual([]);
    expect(flattenYamlLists(42)).toEqual([]);
    expect(flattenYamlLists(['a', 'b'])).toEqual([]); // bare array handled by the caller
  });
});

describe('processWildcardEntries — parsing', () => {
  it('builds lists from txt + yaml, names txt after the file', async () => {
    const entries = [
      entry('colors.txt', { text: 'red\nblue\nred' }),
      entry('nested/nouns.yaml', { text: JSON.stringify({ animals: ['cat', 'dog'] }) }),
    ];
    const { lists, truncated } = await processWildcardEntries(entries, WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    expect(lists).toEqual({ colors: ['red', 'blue'], animals: ['cat', 'dog'] });
    expect(truncated).toBe(false);
  });

  it('an images-only zip yields empty lists, not an error', async () => {
    const entries = [entry('a.png', { failRead: true }), entry('b.jpg', { failRead: true })];
    const { lists, truncated } = await processWildcardEntries(entries, WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    // failRead would throw IF read — but classifier skips images before any read.
    expect(lists).toEqual({});
    expect(truncated).toBe(false);
  });

  it('NEVER inflates a skipped image / nested zip / dotfile (read not called)', async () => {
    let read = false;
    const entries = [
      entry('preview.png', { onRead: () => (read = true) }),
      entry('inner.zip', { onRead: () => (read = true) }),
      entry('.DS_Store', { onRead: () => (read = true) }),
    ];
    await processWildcardEntries(entries, WILDCARD_PACK_CAPS, { parseYaml: jsonYaml });
    expect(read).toBe(false);
  });

  it('tolerates malformed yaml (skips the list + flags truncated, never throws)', async () => {
    const entries = [
      entry('good.txt', { text: 'a\nb' }),
      entry('bad.yaml', { text: '{ not: valid json' }),
    ];
    const { lists, truncated } = await processWildcardEntries(entries, WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    expect(lists).toEqual({ good: ['a', 'b'] });
    expect(truncated).toBe(true);
  });

  it('names a bare top-level array yaml after the file', async () => {
    const entries = [entry('moods.yaml', { text: JSON.stringify(['happy', 'sad']) })];
    const { lists } = await processWildcardEntries(entries, WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    expect(lists).toEqual({ moods: ['happy', 'sad'] });
  });
});

describe('processWildcardEntries — the anti-zip-bomb inflation caps (the #3130 security gap)', () => {
  it('SKIPS an entry whose DECLARED size exceeds the per-entry cap — WITHOUT inflating it', async () => {
    let inflated = false;
    const bomb = entry('bomb.txt', {
      declaredSize: WILDCARD_PACK_CAPS.perEntryBytes + 1,
      onRead: () => (inflated = true),
    });
    const { lists, truncated } = await processWildcardEntries([bomb], WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    expect(inflated).toBe(false); // never read — the declared-size belt short-circuits
    expect(lists).toEqual({});
    expect(truncated).toBe(true);
  });

  it('BOUNDS inflation via the per-entry read limit (read is called with a bounded limit, hitLimit truncates)', async () => {
    let seenLimit = -1;
    // A hyper-inflating entry whose declared size is unknown (null) — the bounded
    // read is the authoritative guard. It reports hitLimit + only `bytes`≈limit.
    const bomb = entry('bomb.txt', {
      declaredSize: null,
      text: 'x'.repeat(10),
      bytes: WILDCARD_PACK_CAPS.perEntryBytes, // bounded, NOT the (huge) real size
      hitLimit: true,
      onRead: (limit) => (seenLimit = limit),
    });
    const { truncated } = await processWildcardEntries([bomb], WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    // read was invoked with a HARD limit ≤ the per-entry cap (never unbounded).
    expect(seenLimit).toBeGreaterThan(0);
    expect(seenLimit).toBeLessThanOrEqual(WILDCARD_PACK_CAPS.perEntryBytes);
    expect(truncated).toBe(true);
  });

  it('bounds the per-entry read to the REMAINING total budget as the total cap is approached', async () => {
    const caps = { ...WILDCARD_PACK_CAPS, totalBytes: 1500, perEntryBytes: 1000 };
    const limits: number[] = [];
    const entries = [
      entry('a.txt', { text: 'a', bytes: 1000, onRead: (l) => limits.push(l) }),
      entry('b.txt', { text: 'b', bytes: 1000, onRead: (l) => limits.push(l) }),
    ];
    await processWildcardEntries(entries, caps, { parseYaml: jsonYaml });
    expect(limits[0]).toBe(1000); // min(perEntry, remaining=1500)
    expect(limits[1]).toBe(500); // min(perEntry=1000, remaining=1500-1000)
  });

  it('STOPS the loop once the total uncompressed budget is exhausted (later entries not read)', async () => {
    const caps = { ...WILDCARD_PACK_CAPS, totalBytes: 1000, perEntryBytes: 1000 };
    let thirdRead = false;
    const entries = [
      entry('a.txt', { text: 'a', bytes: 1000 }),
      entry('b.txt', { text: 'b', bytes: 1000, onRead: () => (thirdRead = true) }),
    ];
    const { truncated } = await processWildcardEntries(entries, caps, { parseYaml: jsonYaml });
    expect(thirdRead).toBe(false); // total budget hit after entry a → loop breaks
    expect(truncated).toBe(true);
  });

  it('caps the number of entries walked at maxEntries', async () => {
    const caps = { ...WILDCARD_PACK_CAPS, maxEntries: 2 };
    let reads = 0;
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry(`f${i}.txt`, { text: `v${i}`, bytes: 4, onRead: () => reads++ })
    );
    const { truncated } = await processWildcardEntries(entries, caps, { parseYaml: jsonYaml });
    expect(reads).toBe(2);
    expect(truncated).toBe(true);
  });

  it('tolerates an unreadable entry (throws in read) without failing the pack', async () => {
    const entries = [
      entry('ok.txt', { text: 'a\nb' }),
      entry('corrupt.txt', { failRead: true }),
    ];
    const { lists, truncated } = await processWildcardEntries(entries, WILDCARD_PACK_CAPS, {
      parseYaml: jsonYaml,
    });
    expect(lists).toEqual({ ok: ['a', 'b'] });
    expect(truncated).toBe(true);
  });
});

describe('processWildcardEntries — result caps flag truncatedLists', () => {
  it('flags a list truncated by the option-count cap', async () => {
    const caps = { ...WILDCARD_PACK_CAPS, maxOptionsPerList: 3 };
    const entries = [entry('big.txt', { text: 'a\nb\nc\nd\ne' })];
    const { lists, truncated, truncatedLists } = await processWildcardEntries(entries, caps, {
      parseYaml: jsonYaml,
    });
    expect(lists.big).toEqual(['a', 'b', 'c']);
    expect(truncated).toBe(true);
    expect(truncatedLists).toEqual(['big']);
  });
});
