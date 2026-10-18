import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonLengthWithin } from '~/server/schema/blocks/json-length';
import type { JsonLengthMeter } from '~/server/schema/blocks/json-length';
import { INLINE_MEDIA_MAX_VISITS } from '~/server/schema/blocks/inline-media';
import {
  blockInlineComfyBodySchema,
  blockMultiStepWorkflowBodySchema,
  blockPassThroughStepBodySchema,
  PASS_THROUGH_INPUT_BYTES_MAX,
} from '~/server/schema/blocks/workflow.schema';
import { upsertSubscriptionSchema } from '~/server/schema/blocks/subscription.schema';

const meter = (): JsonLengthMeter => ({ visits: 0, chars: 0, scanned: 0 });

/** The length in `unit`, read from the measure with a limit it cannot reach. */
function measured(value: unknown, unit: 'utf16' | 'utf8' = 'utf16') {
  const m = meter();
  expect(jsonLengthWithin([value], Number.MAX_SAFE_INTEGER, { unit, meter: m })).toBe(true);
  return m.chars;
}

const shared = { name: 'shared', tags: ['a', 'b'] };
const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays

const corpus: [string, unknown][] = [
  ['nested objects and arrays', { a: { b: [1, { c: [[], {}, [[]]] }] }, d: [] }],
  ['unicode', { latin: 'héllo', cjk: '日本語', emoji: '😀👍🏽', mixed: 'aé日😀' }],
  ['escapes', { q: '"', b: '\\', ws: '\n\t\r\b\f', ctl: '\u0000\u0001\u001f\u007f', slash: '/' }],
  ['lone surrogates', ['\ud800', 'a\udc00b', '\udc00\ud800', '\udbff', 'x\ud83d', '😀']],
  ['numbers', [0, -0, 1e21, 1e-7, 1.5, -123, NaN, Infinity, -Infinity, Number.MAX_VALUE, 5e-324]],
  ['booleans and null', { t: true, f: false, n: null, list: [true, false, null] }],
  ['undefined properties', { a: undefined, b: 1, c: undefined, nested: { only: undefined } }],
  ['functions and symbols', { f: () => 0, s: Symbol('s'), arr: [() => 1, Symbol('t'), undefined] }],
  ['an object whose every property is omitted', { a: undefined, b: () => 1 }],
  ['keys that need escaping', { '"\n': 1, '😀': 2, '\ud800': 3, '': 4, 'a\\b': 5 }],
  ['a sparse array', sparse],
  ['toJSON and boxed values', [new Date(0), new Number(3), new String('s"'), new Boolean(false)]],
  ['maps and sets', { m: new Map([['k', 1]]), s: new Set([1]) }],
  ['a toJSON that returns an object', { v: { toJSON: () => ({ inner: [1, 'two'] }) } }],
  [
    'a toJSON that reads its key',
    { when: { toJSON: (k: string) => k.repeat(3) }, list: [{ toJSON: (k: string) => k }] },
  ],
  ['an invalid date', [new Date(NaN)]],
  ['a toJSON that returns a Date', { a: { toJSON: () => new Date(0) } }],
  [
    'a toJSON that returns an object with its own toJSON',
    { a: { toJSON: () => ({ toJSON: () => 'x'.repeat(50) }) } },
  ],
  ['a toJSON that returns a boxed string', { a: { toJSON: () => new String('boxed') } }],
  ['a top-level toJSON', { toJSON: (k: string) => `key:${k}` }],
  ['a shared object, three times', [shared, shared, { again: shared }]],
  ['a top-level string', 'top "level"\n'],
  ['a top-level number', -0.5],
  ['top-level null', null],
];

describe('jsonLengthWithin', () => {
  describe('equals JSON.stringify', () => {
    it.each(corpus)('%s, in UTF-16 code units', (_, value) => {
      expect(measured(value)).toBe((JSON.stringify(value) as string).length);
    });

    it.each(corpus)('%s, in UTF-8 bytes', (_, value) => {
      expect(measured(value, 'utf8')).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
    });

    it.each(corpus)('%s, with the verdict flipping exactly at the limit', (_, value) => {
      const length = (JSON.stringify(value) as string).length;
      expect(jsonLengthWithin([value], length - 1)).toBe(false);
      expect(jsonLengthWithin([value], length)).toBe(true);
      expect(jsonLengthWithin([value], length + 1)).toBe(true);
    });

    it.each(corpus)('%s, with the UTF-8 verdict flipping exactly at the limit', (_, value) => {
      const length = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
      expect(jsonLengthWithin([value], length - 1, { unit: 'utf8' })).toBe(false);
      expect(jsonLengthWithin([value], length, { unit: 'utf8' })).toBe(true);
    });

    it('sums several values against one limit', () => {
      const values = [{ a: 'x' }, { b: [1, 2] }, shared];
      const total = values.reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0);
      expect(jsonLengthWithin(values, total)).toBe(true);
      expect(jsonLengthWithin(values, total - 1)).toBe(false);
    });

    it('counts nothing for a top-level value JSON.stringify drops', () => {
      expect(measured(undefined)).toBe(0);
      expect(measured(() => 1)).toBe(0);
    });

    it('throws where JSON.stringify throws', () => {
      expect(() => jsonLengthWithin([{ n: 1n }], 1000)).toThrow(TypeError);
      expect(() => jsonLengthWithin([{ n: Object(1n) }], 1000)).toThrow(TypeError);
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = { back: cyclic };
      expect(() => jsonLengthWithin([cyclic], 1000)).toThrow(TypeError);
    });
  });

  describe('flags a NUL or an unpaired surrogate', () => {
    // The pattern the shared-storage write path matched against `JSON.stringify` output before
    // the flag replaced it: a `\u0000` or `\udXXX` escape not itself escaped by a backslash.
    const STRINGIFIED_ESCAPE = /(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/;
    const flagged = (value: unknown) => {
      const m = meter();
      expect(jsonLengthWithin([value], Number.MAX_SAFE_INTEGER, { unit: 'utf8', meter: m })).toBe(
        true
      );
      return m.nulOrLoneSurrogate === true;
    };
    const cases: [string, unknown, boolean][] = [
      ['a NUL in a string', { s: 'a\u0000b' }, true],
      ['a NUL in a key', { ['k\u0000']: 1 }, true],
      ['a NUL after a literal backslash', { s: 'a\\\u0000' }, true],
      ['a lone high surrogate', ['a\ud800b'], true],
      ['a lone low surrogate', ['a\udc00'], true],
      ['a reversed pair', ['\udc00\ud800'], true],
      ['a lone surrogate in a key', { ['\udbff']: 1 }, true],
      ['a lone surrogate after a literal backslash', ['\\\ud800'], true],
      ['a NUL from toJSON', { d: { toJSON: () => 'x\u0000' } }, true],
      ['a NUL deep in a shared object', [shared, { deep: [[{ s: '\u0000' }]] }], true],
      ['a paired surrogate', { s: '😀', k: '😀👍🏽' }, false],
      ['normal unicode', { latin: 'héllo', cjk: '日本語', mixed: 'aé日😀' }, false],
      ['other control characters', { s: '\u0001\u001f\n\t\u007f' }, false],
      ['the six characters \\u0000', { s: '\\u0000', t: '\\\\u0000' }, false],
      ['a NUL in a property JSON.stringify leaves out', { f: undefined, g: () => '\u0000' }, false],
    ];
    it.each(cases)('%s', (_, value, expected) => {
      expect(flagged(value)).toBe(expected);
      expect(STRINGIFIED_ESCAPE.test(JSON.stringify(value))).toBe(expected);
    });

    it.each(corpus)('%s, as the stringified pattern reads it', (_, value) => {
      expect(flagged(value)).toBe(STRINGIFIED_ESCAPE.test(JSON.stringify(value) ?? ''));
    });
  });

  describe('stops once the total passes the limit', () => {
    const LIMIT = PASS_THROUGH_INPUT_BYTES_MAX;

    it('for one string repeated far past the limit', () => {
      const text = 'word '.repeat(20_000); // 100,000 characters
      const value = { items: new Array(1_000).fill(text) }; // 100 MB once serialised
      const m = meter();
      expect(jsonLengthWithin([value], LIMIT, { meter: m })).toBe(false);
      expect(m.scanned).toBeLessThanOrEqual(LIMIT);
    });

    it('for one object repeated far past the limit', () => {
      const row = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i]));
      // 2,000 x 101 values: inside the value budget, ~2 MB once serialised.
      const value = new Array(2_000).fill(row);
      const m = meter();
      expect(jsonLengthWithin([value], LIMIT, { meter: m })).toBe(false);
      expect(m.scanned).toBeLessThanOrEqual(LIMIT);
      // The array's 2,000 items are charged when it opens; ~270 rows of 101 values fit.
      expect(m.visits).toBeLessThan(40_000);
    });

    it('and refuses more values than the inline-media budget allows', () => {
      const pad = Object.fromEntries(
        Array.from({ length: 300_000 }, (_, i) => [`k${i}`, undefined])
      );
      expect(JSON.stringify(pad).length).toBe(2);
      const m = meter();
      expect(jsonLengthWithin([pad], LIMIT, { meter: m })).toBe(false);
      expect(m.visits).toBe(INLINE_MEDIA_MAX_VISITS + 1);
    });
  });
});

describe('request size caps on a repeated value', () => {
  const text = 'word '.repeat(20_000);
  const repeated = { items: new Array(1_000).fill(text) };
  let stringified = 0;

  /** Counts the characters JSON.stringify produces while `run` runs. */
  function serialisedDuring<T>(run: () => T): T {
    stringified = 0;
    const real = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof real>) => {
      const out = real(...args);
      stringified += out?.length ?? 0;
      return out;
    });
    try {
      return run();
    } finally {
      vi.restoreAllMocks();
    }
  }

  afterEach(() => vi.restoreAllMocks());

  const issues = (r: {
    success: boolean;
    error?: { issues: { path: unknown; message: string }[] };
  }) => (r.success ? [] : r.error?.issues.map((i) => [i.path, i.message]));

  it('refuses a pass-through input without building a value-sized string', () => {
    const body = { kind: 'step', $type: 'echo', input: repeated, maxBuzz: 10 };
    const r = serialisedDuring(() => blockPassThroughStepBodySchema.safeParse(body));
    expect(issues(r)).toEqual([[['input'], 'step input exceeds the 262144-byte limit']]);
    expect(stringified).toBeLessThan(PASS_THROUGH_INPUT_BYTES_MAX);
  });

  it('refuses a multi-step workflow without building a value-sized string', () => {
    const body = {
      kind: 'workflow',
      steps: [{ $type: 'echo', input: { small: 1 } }],
      arguments: repeated,
    };
    const r = serialisedDuring(() => blockMultiStepWorkflowBodySchema.safeParse(body));
    expect(issues(r)).toEqual([
      [['steps'], 'workflow step inputs and arguments exceed the 262144-byte limit'],
    ]);
    expect(stringified).toBeLessThan(PASS_THROUGH_INPUT_BYTES_MAX);
  });

  it('refuses step inputs that are each under the cap but over it together', () => {
    const third = { p: '.'.repeat(100_000) };
    const body = {
      kind: 'workflow',
      steps: [
        { $type: 'echo', input: third },
        { $type: 'echo', input: third },
        { $type: 'echo', input: third },
      ],
    };
    const r = blockMultiStepWorkflowBodySchema.safeParse(body);
    expect(issues(r)).toEqual([
      [['steps'], 'workflow step inputs and arguments exceed the 262144-byte limit'],
    ]);
  });

  it('refuses an inline graph without building a value-sized string', () => {
    const body = {
      kind: 'customComfy',
      mode: 'inline',
      workflow: { '1': { class_type: 'Note', inputs: repeated } },
      resources: [],
      maxBuzz: 10,
    };
    const r = serialisedDuring(() => blockInlineComfyBodySchema.safeParse(body));
    expect(issues(r)).toEqual([[['workflow'], 'inline workflow exceeds the 262144-byte limit']]);
    expect(stringified).toBeLessThan(PASS_THROUGH_INPUT_BYTES_MAX);
  });

  it('refuses subscription settings without building a value-sized string', () => {
    const body = {
      appBlockId: 'block',
      scope: 'viewer_personal',
      settings: repeated,
      targetModelTypes: null,
      targetBaseModels: null,
    };
    const r = serialisedDuring(() => upsertSubscriptionSchema.safeParse(body));
    expect(issues(r)).toEqual([[['settings'], 'settings exceeds 4KB']]);
    expect(stringified).toBeLessThan(PASS_THROUGH_INPUT_BYTES_MAX);
  });

  it('caps subscription settings in UTF-8 bytes, not UTF-16 units', () => {
    // `{"s":"…"}` is 8 bytes of framing; each 日 is 3 UTF-8 bytes and 1 UTF-16 unit.
    const settings = (extra: string) => ({ s: '日'.repeat(1_362) + extra });
    const body = (extra: string) => ({
      appBlockId: 'block',
      scope: 'viewer_personal',
      settings: settings(extra),
      targetModelTypes: null,
      targetBaseModels: null,
    });
    expect(Buffer.byteLength(JSON.stringify(settings('ab')), 'utf8')).toBe(4096);
    expect(JSON.stringify(settings('abc')).length).toBeLessThan(4096);
    expect(upsertSubscriptionSchema.safeParse(body('ab')).success).toBe(true);
    expect(issues(upsertSubscriptionSchema.safeParse(body('abc')))).toEqual([
      [['settings'], 'settings exceeds 4KB'],
    ]);
  });
});
