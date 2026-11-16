import { describe, expect, it } from 'vitest';
import {
  FILTER_PATTERN_MAX_LENGTH,
  FILTER_PATTERN_MAX_SIZE,
  FilterPatternError,
  compileFilterPattern,
} from '~/server/registry-adapter/filter-pattern';
import {
  FILTER_MAX_PATTERNS,
  FILTER_PATTERNS_MAX_TOTAL_SIZE,
  createFilterCompiler,
} from '~/server/registry-adapter/json-schema';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/**
 * A filter's `pattern` and `patternProperties` run on a linear-time engine (RE2, via re2js) with
 * ECMA-262's meaning, or are refused with `bad_request`; never silently evaluated otherwise.
 */

/** Patterns whose meaning must equal the platform's ECMA-262 (`u` flag) on every input below. */
const PATTERNS = [
  '^urn:schema:civitai.com:',
  'civitai',
  '^a$',
  '\\d+',
  '^\\D$',
  '^\\w+$',
  '\\bfoo\\b',
  '\\B',
  '\\u0041',
  '\\u{1F600}',
  '^\\uD83D\\uDE00$',
  '\\x41',
  '\\cJ',
  '\\0',
  '^.$',
  '^\\s$',
  '^\\S$',
  '^[\\s]$',
  '[^\\s]',
  '^[^]$',
  '^[]$',
  'x[]?y',
  '(?<n>a)b',
  'a/b',
  '\\/',
  '[a-z]+',
  '^[a-c-e]$',
  '[-a]',
  '[a-]',
  '[\\w-]',
  '[^a]',
  '[\\b]',
  'a{2,3}',
  'a{2,}?',
  '^a{01}$',
  '^a{1,02}$',
  '^a{00,}$',
  '^a{0002}$',
  '(a|b)*c',
  '^(?:ab)+$',
  '[.]',
  '\\.',
  '[\\]]',
  '[\\[]',
  '\\{',
  '^\\$',
  '\\^',
  '😀',
  '^[😀-😂]$',
  'é',
  'a|',
  '()',
  '',
];

const INPUTS = [
  '',
  'a',
  'A',
  'aa',
  'ab',
  'abc',
  'ababab',
  'abac',
  'b',
  'cc',
  'd',
  'e',
  'q',
  'Q',
  'x',
  'xy',
  '7',
  '123',
  'urn:schema:civitai.com:x',
  'z:urn:schema:civitai.com:',
  'foo bar',
  'xfoo',
  '\n',
  '\r',
  '\u2028',
  '\u000b',
  '\u00a0',
  '\ufeff',
  ' ',
  '\t',
  '\0',
  '\b',
  'é',
  'É',
  'α',
  '😀',
  '😁',
  '😃',
  'a/b',
  '/',
  '.',
  ']',
  '[',
  '-',
  '$',
  '^',
  '{',
];

describe('🔴 a filter pattern means what ECMA-262 says it means', () => {
  it.each(PATTERNS.map((p) => [p]))('%j agrees with the platform RegExp on every input', (p) => {
    const re2 = compileFilterPattern(p);
    const native = new RegExp(p, 'u');
    const disagreements = INPUTS.filter((s) => re2.test(s) !== native.test(s));
    expect(disagreements).toEqual([]);
  });

  // The places RE2's own syntax means something else, pinned with literal verdicts.
  it.each([
    ['^.$', '\r', false],
    ['^.$', '\u2028', false],
    ['^.$', '😀', true],
    ['^\\s$', '\u000b', true],
    ['^\\s$', '\u00a0', true],
    ['^\\S$', '\u00a0', false],
    ['^[]$', '', false],
    ['^[^]$', '\n', true],
    // RE2 reads a count with a leading zero as literal text; ECMA reads the number.
    ['^a{01}$', 'a', true],
    ['^a{01}$', 'a{01}', false],
    ['^a{1,02}$', 'aa', true],
    ['^a{1,02}$', 'a{1,02}', false],
    ['^a{00,}$', 'aaa', true],
    ['^a{00,}$', 'a{00,}', false],
  ])('%j on %j is %s', (p, s, expected) => {
    expect(compileFilterPattern(p).test(s)).toBe(expected);
  });

  it('is unanchored, as ECMA-262 is: a match anywhere in the string counts', () => {
    const rx = compileFilterPattern('civitai.com');
    expect([rx.test('urn:schema:civitai.com:x'), rx.test('civitai.co')]).toEqual([true, false]);
  });
});

describe('🔴 a pattern the linear-time engine cannot run with its meaning is refused', () => {
  it.each([
    ['a lookahead', '(?=a)a', 'a lookahead'],
    ['a negative lookahead', '^(?!x)', 'a lookahead'],
    ['a lookbehind', '(?<=a)b', 'a lookbehind'],
    ['a negative lookbehind', '(?<!a)b', 'a lookbehind'],
    ['a numbered backreference', '(a)\\1', 'a backreference'],
    ['a named backreference', '(?<n>a)\\k<n>', 'a backreference'],
    ['a pattern modifier', '(?i:a)', 'a pattern modifier'],
    ['\\S in a class', '[\\S]', '\\S inside a character class'],
    // re2js's Unicode tables and names can differ from the platform's: refused, not guessed at.
    ['a Unicode property', '\\p{L}', 'a Unicode property escape'],
    ['a negated Unicode property', '\\P{L}', 'a Unicode property escape'],
    ['a Unicode property in a class', '[\\p{Lu}\\d]', 'a Unicode property escape'],
    ['a script property', '\\p{Script=Greek}', 'a Unicode property escape'],
    ['a binary property', '\\p{Alphabetic}', 'a Unicode property escape'],
    ['a lone surrogate', '\\uD800', 'a lone surrogate'],
    ['a repeat count over the size bound', 'a{1100}', 'is larger than 256 once'],
    ['nested counts over the size bound', '(a{100}){100}', 'is larger than 256 once'],
    ['an invalid ECMA-262 pattern', '[', 'not a valid ECMA-262 regular expression'],
    ['RE2-only syntax', '(?i)a', 'not a valid ECMA-262 regular expression'],
  ])('%s: refused, saying why', (_name, p, why) => {
    expect(() => compileFilterPattern(p)).toThrow(FilterPatternError);
    expect(() => compileFilterPattern(p)).toThrow(why);
  });

  it('a pattern over the length bound is refused; one at it is compiled', () => {
    expect(FILTER_PATTERN_MAX_LENGTH).toBe(1024);
    expect(() => compileFilterPattern('a'.repeat(1025))).toThrow(
      'is longer than 1024 characters, which this registry does not apply'
    );
    // 1024 characters but size 1 (one class), so only the length bound is at stake.
    const atLength = `[${'a'.repeat(1022)}]`;
    expect(atLength.length).toBe(1024);
    expect([
      compileFilterPattern(atLength).test('a'),
      compileFilterPattern(atLength).test('b'),
    ]).toEqual([true, false]);
  });
});

/** `unit` repeated for as long as the result fits in `max` characters. */
const fill = (unit: string, max = FILTER_PATTERN_MAX_LENGTH) =>
  unit.repeat(Math.floor(max / unit.length));

describe('🔴 a pattern whose counted repetitions multiply out too large is refused', () => {
  it('the bound is 256, and a literal pattern counts its length', () => {
    expect(FILTER_PATTERN_MAX_SIZE).toBe(256);
    expect(compileFilterPattern('a'.repeat(200)).size).toBe(200);
  });

  // Each fits the length bound and every single count RE2 accepts, so only the size refuses them.
  // Measured at the PR head, the first took ~0.7 s against 10 000 `é` then a newline.
  it.each([
    ['.{1000} side by side', fill('.{1000}')],
    ['(?:.{1000}){1} side by side', fill('(?:.{1000}){1}')],
    ['.{0,1000} side by side', fill('.{0,1000}')],
    ['two .{1000}', '.{1000}.{1000}'],
    ['one count past the bound', '.{300}'],
    ['nested counts multiplying past the bound', '(?:a{20}){15}'],
    ['empty groups repeated', '(){1000}(){1000}'],
    ['a literal longer than the size bound', 'a'.repeat(300)],
  ])('%s: refused before it is compiled', (_name, p) => {
    expect(p.length).toBeLessThanOrEqual(FILTER_PATTERN_MAX_LENGTH);
    expect(() => compileFilterPattern(p)).toThrow(FilterPatternError);
    expect(() => compileFilterPattern(p)).toThrow(
      'is larger than 256 once its counted repetitions are multiplied out'
    );
  });

  it.each([
    ['.{199}', 199],
    ['(?:a{12}){15}', 195],
    ['^[a-z0-9-]{1,64}$', 66],
    ['a{01}', 1],
  ])('%s is under the bound, with size %i, and is compiled', (p, size) => {
    expect(compileFilterPattern(p).size).toBe(size);
  });
});

describe('🔴 a backtracking pattern runs in linear time', () => {
  // The platform RegExp takes time exponential in the run of `a`s here; these finish at once.
  it.each([[30], [20_000]])('^(a+)+$ against %i a then b: no match, and it returns', (n) => {
    const rx = compileFilterPattern('^(a+)+$');
    expect(rx.test(`${'a'.repeat(n)}b`)).toBe(false);
    expect(rx.test('a'.repeat(n))).toBe(true);
  });
});

describe('createFilterCompiler with patterns', () => {
  const compile = createFilterCompiler();

  it('applies pattern: a match and a non-match', () => {
    const f = compile({ properties: { $id: { pattern: '^urn:schema:civitai.com:' } } })!;
    expect([
      f({ $id: 'urn:schema:civitai.com:app@v1' }),
      f({ $id: 'urn:schema:elsewhere.example:app@v1' }),
    ]).toEqual([true, false]);
  });

  // ajv keys each compiled pattern by its `toString()`; two patterns must not share one.
  it('two different patterns in one filter are each their own', () => {
    const f = compile({ properties: { a: { pattern: '^x' }, b: { pattern: '^y' } } })!;
    expect([f({ a: 'x', b: 'y' }), f({ a: 'x', b: 'x' }), f({ a: 'y', b: 'y' })]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('applies patternProperties to the keys it matches only', () => {
    const f = compile({ patternProperties: { '^n_': { type: 'number' } } })!;
    expect([f({ n_a: 1, s: 'text' }), f({ n_a: 'text' }), f({ s: 'text' })]).toEqual([
      true,
      false,
      true,
    ]);
  });

  it.each([
    ['a lookahead in pattern', { properties: { slug: { pattern: '(?=z)' } } }, 'a lookahead'],
    [
      'a backreference in patternProperties',
      { patternProperties: { '(a)\\1': { type: 'number' } } },
      'a backreference',
    ],
    ['an over-long pattern', { pattern: 'x'.repeat(1025) }, 'longer than 1024 characters'],
    ['a pattern over the size bound', { pattern: fill('.{1000}') }, 'is larger than 256 once'],
    ['a Unicode property', { pattern: '\\p{L}' }, 'a Unicode property escape'],
    ['a negated Unicode property', { pattern: '\\P{L}' }, 'a Unicode property escape'],
    // Each is under the per-pattern bound (size 200); together they are 600.
    [
      'three patterns over the total size',
      { allOf: ['x', 'y', 'z'].map((e) => ({ properties: { d: { pattern: `[ab]{199}${e}` } } })) },
      'larger than 512 in total',
    ],
    // One pattern of size 200, applied in three places: counted in each, so 600.
    [
      'one pattern applied in three places, over the total size',
      {
        properties: {
          a: { pattern: 'a{200}' },
          b: { pattern: 'a{200}' },
          c: { pattern: 'a{200}' },
        },
      },
      'larger than 512 in total',
    ],
    [
      'more distinct patterns than the bound',
      {
        properties: Object.fromEntries(
          [...Array(9).keys()].map((k) => [`p${k}`, { pattern: `^${k}` }])
        ),
      },
      'more than 8 distinct patterns',
    ],
  ])('%s: bad_request, naming the reason', (_name, filter, why) => {
    let err: unknown;
    try {
      compile(filter);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('bad_request');
    expect((err as Error).message).toContain(why);
  });

  it('the filter bounds: the total is two largest patterns, and 8 distinct patterns', () => {
    expect([FILTER_PATTERNS_MAX_TOTAL_SIZE, FILTER_MAX_PATTERNS]).toEqual([512, 8]);
  });

  // Positive controls for the filter bounds: under each, the filter is applied.
  it('patterns under the total size (two of size 200) are applied', () => {
    const f = compile({
      allOf: ['x', 'y'].map((e) => ({ properties: { d: { pattern: `[ab]{199}${e}` } } })),
    })!;
    expect([f({ d: `${'a'.repeat(199)}x${'b'.repeat(199)}y` }), f({ d: 'a'.repeat(199) })]).toEqual(
      [true, false]
    );
  });

  it('one pattern of size 200 in two places (400) is applied', () => {
    const f = compile({ properties: { a: { pattern: 'a{200}' }, b: { pattern: 'a{200}' } } })!;
    expect([f({ a: 'a'.repeat(200), b: 'a'.repeat(200) }), f({ a: 'a'.repeat(199) })]).toEqual([
      true,
      false,
    ]);
  });

  // ajv's meta-schema holds patterns of its own; they must not count against the filter's bound.
  it('8 distinct patterns, with a $id, are applied', () => {
    const f = compile({
      $id: 'urn:example:filter',
      properties: Object.fromEntries(
        [...Array(8).keys()].map((k) => [`p${k}`, { pattern: `^${k}` }])
      ),
    })!;
    expect([f({ p3: '3' }), f({ p3: '4' })]).toEqual([true, false]);
  });
});

describe('the filter cache counts patterns, not only filters', () => {
  // A cached pattern can keep megabytes of DFA, so the cache is emptied by its pattern count.
  it('is emptied once its filters hold more than maxCachedPatterns patterns', () => {
    const compile = createFilterCompiler(100, 16);
    const first = compile({ pattern: '^a' });
    for (let k = 0; k < 16; k++) compile({ pattern: `^b${k}` });
    expect(compile({ pattern: '^a' })).not.toBe(first);
  });

  it('positive control: under the count, a filter is served from the cache', () => {
    const compile = createFilterCompiler(100, 16);
    const first = compile({ pattern: '^a' });
    for (let k = 0; k < 10; k++) compile({ pattern: `^b${k}` });
    expect(compile({ pattern: '^a' })).toBe(first);
  });
});
