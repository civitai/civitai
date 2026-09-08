import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  serializeJsonObject,
  writeJsonObject,
  type JsonObjectEntry,
  type JsonReplacer,
} from '~/server/utils/json-stream-helpers';

/**
 * The defect these exist for: the CSAM base evidence bundle was produced by one
 * `JSON.stringify({ user, reportId, models, modelVersions, images }, replacer)` over arrays
 * loaded with unpaginated `findMany`s. That has a HARD ceiling independent of how much memory
 * the host has — `JSON.stringify` returns a single JavaScript string, and a JS string cannot
 * exceed V8's maximum length (536,870,888 characters on 64-bit, i.e.
 * `require('buffer').constants.MAX_STRING_LENGTH`), past which it throws
 * `RangeError: Invalid string length` on every attempt forever.
 *
 * The bundle is evidence, so the bar is not "smaller memory" but "byte-identical document,
 * produced without ever building that string". Both halves are asserted below.
 *
 * Every number and every row in this file is invented.
 */

/** The replacer the service uses, reproduced verbatim — `Image.pHash` is a `BigInt` column. */
const bigintReplacer: JsonReplacer = (_key, value) =>
  typeof value === 'bigint' ? value.toString() : value;

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-stream-helpers-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function collect(
  entries: Iterable<readonly [string, JsonObjectEntry]>,
  replacer?: JsonReplacer
) {
  let out = '';
  for await (const chunk of serializeJsonObject(entries, replacer)) out += chunk;
  return out;
}

/** Yields from an array one element at a time, so the streamed path is genuinely incremental. */
async function* asStream<T>(rows: T[]) {
  for (const row of rows) {
    await Promise.resolve();
    yield row;
  }
}

describe('serializeJsonObject byte-identity with JSON.stringify', () => {
  /**
   * Deliberately awkward: a bigint (the reason a replacer exists at all), a Date (which is
   * serialised via `toJSON` BEFORE the replacer sees it), nested nulls, an empty array, a key
   * and a value both needing JSON escaping, and non-BMP characters.
   */
  const model = (id: number) => ({
    id,
    name: `mo"del\\ ${id}\n\t`,
    createdAt: new Date(Date.UTC(2019, 4, 7, 3, 14, 15, 926)),
    tags: [] as string[],
    nested: { a: null, b: [1, 2, { c: 'ünïcødé 🜛' }] },
    'quoted"key': `line1
line2`,
  });
  const image = (id: number) => ({
    id,
    pHash: BigInt('9007199254740993') + BigInt(id),
    meta: { prompt: 'a'.repeat(11), steps: 27 },
    url: `uuid-${id}`,
  });

  // `\u2028` (LINE SEPARATOR) written as an escape, not as a raw byte: it is a legal string
  // character but a line terminator to several parsers, and JSON.stringify passes it through
  // unescaped — so it is exactly the kind of character a hand-rolled serialiser gets wrong.
  const user = { id: 41, name: null, email: 'e\u2028x@example.invalid', username: 'u' };
  const models = Array.from({ length: 7 }, (_, i) => model(i + 1));
  const images = Array.from({ length: 13 }, (_, i) => image(i + 1));

  it('produces exactly the bytes JSON.stringify produces for the same document', async () => {
    const expected = JSON.stringify(
      { user, reportId: 77, models, modelVersions: [], images },
      bigintReplacer
    );
    const actual = await collect(
      [
        ['user', { value: user }],
        ['reportId', { value: 77 }],
        ['models', { items: asStream(models) }],
        ['modelVersions', { items: asStream([]) }],
        ['images', { items: asStream(images) }],
      ],
      bigintReplacer
    );

    // Positive control on the fixture itself: if it did not exercise the replacer, an identity
    // assertion between two replacer-less paths would pass while proving nothing about bigints.
    expect(expected).toContain('"9007199254740994"');
    expect(actual).toBe(expected);
  });

  it('omits a property whose value is undefined, exactly as JSON.stringify does', async () => {
    const expected = JSON.stringify({ a: 1, b: undefined, c: 3 });
    expect(expected).toBe('{"a":1,"c":3}');
    const actual = await collect([
      ['a', { value: 1 }],
      ['b', { value: undefined }],
      ['c', { value: 3 }],
    ]);
    expect(actual).toBe(expected);
  });

  it('omits a leading undefined property without emitting a stray comma', async () => {
    // The comma bookkeeping is the part a naive index-based implementation gets wrong.
    const expected = JSON.stringify({ a: undefined, b: 2 });
    const actual = await collect([
      ['a', { value: undefined }],
      ['b', { value: 2 }],
    ]);
    expect(actual).toBe(expected);
    expect(actual).toBe('{"b":2}');
  });

  it('renders an unserialisable ARRAY element as null rather than dropping it', async () => {
    const items = [1, undefined, () => 0, 4];
    const expected = JSON.stringify({ xs: items });
    expect(expected).toBe('{"xs":[1,null,null,4]}');
    const actual = await collect([['xs', { items: asStream(items) }]]);
    expect(actual).toBe(expected);
  });

  it('escapes keys the way JSON.stringify does', async () => {
    const key = 'a"b\\c\ndé';
    const expected = JSON.stringify({ [key]: 1 });
    const actual = await collect([[key, { value: 1 }]]);
    expect(actual).toBe(expected);
  });

  it('accepts a synchronous iterable for an array entry', async () => {
    const expected = JSON.stringify({ xs: [1, 2, 3] });
    expect(await collect([['xs', { items: [1, 2, 3] }]])).toBe(expected);
  });
});

/**
 * Installs V8's string-length failure at a small, test-chosen size.
 *
 * This is the mechanism, not an approximation of it: V8 throws `RangeError: Invalid string
 * length` when a string operation would exceed the maximum string length, and `JSON.stringify`
 * has no way to return a document larger than that. Capping it at a few KB rather than ~512 MB
 * lets a fixture that fits in a test exercise the same failure a very large library exercises in
 * production.
 */
async function withMaxStringLength<T>(cap: number, fn: () => Promise<T>) {
  const real = JSON.stringify;
  let longest = 0;
  const patched = ((value: unknown, replacer?: unknown, space?: unknown) => {
    const out = (real as (v: unknown, r?: unknown, s?: unknown) => string | undefined)(
      value,
      replacer,
      space
    );
    if (typeof out === 'string') {
      if (out.length > longest) longest = out.length;
      if (out.length > cap) throw new RangeError('Invalid string length');
    }
    return out;
  }) as typeof JSON.stringify;
  (JSON as { stringify: typeof JSON.stringify }).stringify = patched;
  try {
    return { result: await fn(), longest };
  } finally {
    (JSON as { stringify: typeof JSON.stringify }).stringify = real;
  }
}

describe('writeJsonObject removes the single-string ceiling', () => {
  // Overshoots the cap by a wide, non-multiple margin so the fixture cannot sit on the boundary
  // it is testing: 400 rows of ~600 bytes is ~240 KB against a 24_000-byte cap, i.e. ~10x over,
  // while any single row is ~40x under it.
  const ROW_COUNT = 400;
  const CAP = 24_000;
  const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    id: i + 1,
    url: `uuid-${i}`,
    pHash: BigInt(1_000_000_000_000) + BigInt(i),
    meta: { prompt: `p${i}-${'x'.repeat(500)}` },
  }));
  const document = { user: { id: 5 }, reportId: 9, models: [], modelVersions: [], images: rows };

  let capturedReal: string;
  beforeAll(() => {
    capturedReal = JSON.stringify(document, bigintReplacer);
  });

  it('POSITIVE CONTROL: the fixture and the cap are large enough to matter', () => {
    expect(capturedReal.length).toBeGreaterThan(CAP * 5);
    // …and no single row is anywhere near the cap, so a per-row serialiser is safe by a margin.
    expect(JSON.stringify(rows[0], bigintReplacer).length).toBeLessThan(CAP / 10);
  });

  it('NEGATIVE CONTROL: the pre-fix one-shot stringify throws RangeError at that cap', async () => {
    await expect(
      withMaxStringLength(CAP, async () => JSON.stringify(document, bigintReplacer))
    ).rejects.toThrow(/Invalid string length/);
  });

  it('streams the identical document through, never building a string above the cap', async () => {
    const outPath = path.join(tmpDir, 'bundle.json');
    const { longest } = await withMaxStringLength(CAP, async () => {
      await writeJsonObject({
        sink: fs.createWriteStream(outPath),
        replacer: bigintReplacer,
        entries: [
          ['user', { value: document.user }],
          ['reportId', { value: document.reportId }],
          ['models', { items: asStream(document.models) }],
          ['modelVersions', { items: asStream(document.modelVersions) }],
          ['images', { items: asStream(rows) }],
        ],
      });
    });

    // The ceiling claim, stated as the quantity that causes the RangeError.
    expect(longest).toBeLessThanOrEqual(CAP);
    expect(longest).toBeLessThan(capturedReal.length);

    // The evidence claim: what landed on disk is the same document, byte for byte.
    expect(fs.readFileSync(outPath, 'utf8')).toBe(capturedReal);
  });

  it('the file is complete the instant writeJsonObject resolves', async () => {
    // The caller opens `fs.createReadStream(outPath)` on the very next line and uploads it, so
    // "complete shortly afterwards" is not good enough.
    const outPath = path.join(tmpDir, 'flushed.json');
    await writeJsonObject({
      sink: fs.createWriteStream(outPath),
      replacer: bigintReplacer,
      entries: [['images', { items: asStream(rows) }]],
    });
    const sizeAtResolve = fs.statSync(outPath).size;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fs.statSync(outPath).size).toBe(sizeAtResolve);
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8')).images).toHaveLength(ROW_COUNT);
  });
});

describe('writeJsonObject error handling', () => {
  it('rejects, rather than leaving the caller with a silently truncated file', async () => {
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('synthetic sink failure'));
      },
    });
    await expect(
      writeJsonObject({ sink, entries: [['xs', { items: asStream([1, 2, 3]) }]] })
    ).rejects.toThrow('synthetic sink failure');
  });

  it('propagates a failure raised mid-scan by the row source', async () => {
    async function* failing() {
      yield { id: 1 };
      throw new Error('synthetic scan failure');
    }
    const sink = fs.createWriteStream(path.join(tmpDir, 'aborted.json'));
    await expect(
      writeJsonObject({ sink, entries: [['images', { items: failing() }]] })
    ).rejects.toThrow('synthetic scan failure');
  });
});

afterEach(() => {
  // Nothing global to reset — `withMaxStringLength` restores in its own `finally`. Asserted here
  // so a future edit that moves the restore out of `finally` fails loudly and locally instead of
  // poisoning every later file in the worker.
  expect(JSON.stringify({ a: 'x'.repeat(50_000) }).length).toBeGreaterThan(50_000);
});
