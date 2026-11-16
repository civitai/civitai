import { describe, expect, it } from 'vitest';
import {
  FILTER_PATTERN_MAX_LENGTH,
  FilterPatternError,
  compileFilterPattern,
} from '~/server/registry-adapter/filter-pattern';
import { createFilterCompiler } from '~/server/registry-adapter/json-schema';
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
  '\\p{L}',
  '\\P{L}',
  '[\\p{Lu}\\d]',
  '\\p{Script=Greek}',
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
    ['a binary property', '\\p{Alphabetic}', 'the Unicode property escape'],
    ['a lone surrogate', '\\uD800', 'a lone surrogate'],
    ['a repeat count RE2 refuses', 'a{1001}', 'cannot be compiled'],
    ['nested counts RE2 refuses', '(a{100}){100}', 'cannot be compiled'],
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
    expect(compileFilterPattern('a'.repeat(1024)).test('a'.repeat(1024))).toBe(true);
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
});
