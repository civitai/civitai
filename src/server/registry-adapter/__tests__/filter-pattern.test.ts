import { RE2JS } from 're2js';
import { describe, expect, it, vi } from 'vitest';
import {
  FILTER_PATTERN_BODY_BUDGET,
  FILTER_PATTERN_DFA_BYTES,
  FILTER_PATTERN_MAX_INPUT_LENGTH,
  FILTER_PATTERN_MAX_LENGTH,
  FILTER_PATTERN_MAX_SIZE,
  FilterPatternError,
  compileFilterPattern,
  dfaSelfTest,
  filterRegExpEngine,
} from '~/server/registry-adapter/filter-pattern';
import {
  FILTER_MAX_PATTERN_PLACES,
  FILTER_PATTERNS_MAX_TOTAL_SIZE,
  createFilterCompiler,
} from '~/server/registry-adapter/json-schema';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/**
 * A filter's `pattern` and `patternProperties` run on a linear-time engine (RE2, via re2js) with
 * ECMA-262's meaning, or are refused with `bad_request`; never silently evaluated otherwise.
 */

// First in the file. A pattern run by the platform RegExp backtracks, and a backtracking match is
// synchronous, so no test timeout can interrupt it: this fails instead, and the backtracking case
// below is short enough that the platform RegExp would still return.
describe('🔴 a compiled pattern runs on re2js, not the platform RegExp', () => {
  it('compileFilterPattern returns no RegExp, and its test is RE2JS#test', () => {
    const rx = compileFilterPattern('^(a+)+$');
    expect(rx).not.toBeInstanceOf(RegExp);
    // Spied after the compile, whose self-test matches through re2js too.
    const re2Test = vi.spyOn(RE2JS.prototype, 'test');
    try {
      expect([rx.test('aab'), rx.test('aa')]).toEqual([false, true]);
      expect(re2Test).toHaveBeenCalledTimes(2);
    } finally {
      re2Test.mockRestore();
    }
  });
});

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

/** Text of `a` and `b` from a fixed seed, which keeps `[ab]*a[ab]{20}$`'s DFA from fitting. */
function randomAb(length: number, seed: number) {
  let x = seed;
  let out = '';
  for (let k = 0; k < length; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += x & 0x10000 ? 'a' : 'b';
  }
  return out;
}

describe('🔴 a compiled pattern keeps a bounded DFA', () => {
  // re2js keeps a pattern's lazily built DFA for the pattern's lifetime, up to 8 MiB by default,
  // and a live subscription keeps its patterns as long as it is open.
  it('the budget is 32 KiB, not re2js default of 8 MiB', () => {
    expect(FILTER_PATTERN_DFA_BYTES).toBe(32768);
  });

  // Read from re2js, after a match whose DFA is far over the budget: the bounded DFA is still the
  // one in use, not a default one re2js built on the first match.
  it.each([['e[^.]{120}\\.'], ['[ab]*a[ab]{20}$'], ['^urn:schema:civitai.com:']])(
    '%s has a 32 KiB DFA after it is compiled and after it matches',
    (p) => {
      const rx = compileFilterPattern(p);
      const before = rx.dfaBytes;
      rx.test(randomAb(20_000, 7));
      rx.test(`${'e'.repeat(200)}. urn:schema:civitai.com:`);
      expect([before, rx.dfaBytes]).toEqual([32768, 32768]);
    }
  );

  it('so does a pattern compiled for a filter', () => {
    const engine = filterRegExpEngine({ maxTotalSize: 512, maxPlaces: 2 });
    engine.arm();
    const rx = engine('s[^.]{120}\\.', 'u') as ReturnType<typeof compileFilterPattern>;
    rx.test(randomAb(5_000, 3));
    expect(rx.dfaBytes).toBe(32768);
  });

  // Past its budget the DFA clears its cache or re2js runs the NFA; the verdicts must not change.
  it('a pattern whose DFA overflows the budget still agrees with the platform RegExp', () => {
    const p = '[ab]*a[ab]{20}$';
    const rx = compileFilterPattern(p);
    const native = new RegExp(p, 'u');
    // A random prefix that overflows the DFA, then an end that fixes the verdict: the 21st code
    // point from the end is `a` (a match), `b`, or the input ends in `c` (no match).
    const ends = [`a${'b'.repeat(20)}`, `b${'a'.repeat(20)}`, 'c'];
    const inputs = [1, 2, 3, 4, 5, 6].map((seed) => `${randomAb(3_000, seed)}${ends[seed % 3]}`);
    expect(inputs.map((s) => rx.test(s))).toEqual(inputs.map((s) => native.test(s)));
    // Positive control: both verdicts occur, so the comparison is not vacuous.
    expect(new Set(inputs.map((s) => native.test(s)))).toEqual(new Set([true, false]));
  });
});

/**
 * re2js internals, reached the way `filter-pattern.ts` reaches them, to simulate a re2js whose DFA
 * does not keep the bound: each patch returns its undo.
 */
type Internals = { re2Input: { prog: unknown; dfa: { constructor: unknown } } };
const sample = (RE2JS.compile('a') as unknown as Internals).re2Input;
const Dfa = sample.dfa.constructor as { prototype: object } & (new (prog: unknown) => unknown);
const Re2Prototype = Object.getPrototypeOf(sample) as object;

/** The DFA's enforced budget fields read `value` and ignore every write (re2js's own included). */
const budgetFieldsStuckAt = (value: number) => () => {
  for (const field of ['stateBudget', 'memBudget']) {
    Object.defineProperty(Dfa.prototype, field, {
      configurable: true,
      get: () => value,
      set: () => undefined,
    });
  }
  return () => {
    for (const field of ['stateBudget', 'memBudget']) {
      delete (Dfa.prototype as Record<string, unknown>)[field];
    }
  };
};

/** re2js matches with a default DFA of its own, leaving the one in `lazyDFA` unused. */
const matcherUsesItsOwnDfa = () => {
  const original = Object.getOwnPropertyDescriptor(Re2Prototype, 'dfa')!;
  const own = new WeakMap<object, unknown>();
  Object.defineProperty(Re2Prototype, 'dfa', {
    configurable: true,
    get(this: { prog: unknown }) {
      if (!own.has(this)) own.set(this, new Dfa(this.prog));
      return own.get(this);
    },
  });
  return () => Object.defineProperty(Re2Prototype, 'dfa', original);
};

describe('🔴 a re2js that does not keep the DFA bound makes every pattern bad_request', () => {
  it('the self-test passes on this re2js, and a pattern compiles', () => {
    expect(dfaSelfTest()).toBe(true);
    expect(compileFilterPattern('[ab]*a[ab]{20}$').test(`a${'b'.repeat(20)}`)).toBe(true);
  });

  it.each([
    // maxMem says 32 KiB but the fields re2js enforces stay at its 8 MiB default.
    ['budget fields at the 8 MiB default', budgetFieldsStuckAt(8 * 1024 * 1024)],
    // The fields read 32 KiB, so a field check passes, but the budget is never spent.
    ['budget fields at 32 KiB that are never spent', budgetFieldsStuckAt(32 * 1024)],
    // The installed DFA is never the one that runs.
    ['a matcher that uses its own default DFA', matcherUsesItsOwnDfa],
  ])('%s: refused, saying why', (_name, patch) => {
    const undo = patch();
    try {
      expect(dfaSelfTest()).toBe(false);
      expect(() => compileFilterPattern('^urn:schema:civitai.com:')).toThrow(FilterPatternError);
      expect(() => compileFilterPattern('^urn:schema:civitai.com:')).toThrow(
        "its regular expression engine's internals changed"
      );
    } finally {
      undo();
    }
    // Positive control: with re2js as shipped again, the same pattern compiles.
    expect(compileFilterPattern('^urn:schema:civitai.com:').test('urn:schema:civitai.com:x')).toBe(
      true
    );
  });
});

describe('🔴 a backtracking pattern runs in linear time', () => {
  // Linear time is what re2js gives; that the pattern runs on re2js is the first test in this
  // file. The run here is short enough that the platform RegExp, which takes time exponential in
  // it, would still return at once, so a regression fails that test rather than hanging here.
  it.each([[20]])('^(a+)+$ against %i a then b: no match, and it returns', (n) => {
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
    // ajv compiles a root `$async` to a validator that answers a promise; nested, it ignores it
    // under allOf and throws under properties. Each is refused by name.
    ['$async at the root', { $async: true, properties: { slug: {} } }, 'filter uses "$async"'],
    ['$async under allOf', { allOf: [{ $async: true }] }, 'filter uses "$async"'],
    [
      '$async under properties',
      { properties: { slug: { $async: true, type: 'string' } } },
      'filter uses "$async"',
    ],
    [
      'a backreference in patternProperties',
      { patternProperties: { '(a)\\1': { type: 'number' } } },
      'a backreference',
    ],
    ['an over-long pattern', { pattern: 'x'.repeat(1025) }, 'longer than 1024 characters'],
    ['a pattern over the size bound', { pattern: fill('.{1000}') }, 'is larger than 256 once'],
    ['a Unicode property', { pattern: '\\p{L}' }, 'a Unicode property escape'],
    ['a negated Unicode property', { pattern: '\\P{L}' }, 'a Unicode property escape'],
    // Each place is under the per-pattern bound (size 200), so only the place count refuses.
    [
      'three distinct patterns: three places',
      { allOf: ['x', 'y', 'z'].map((e) => ({ properties: { d: { pattern: `[ab]{199}${e}` } } })) },
      'applies patterns in more than 2 places',
    ],
    [
      'one pattern in three places: one distinct pattern, three places',
      { properties: { a: { pattern: '^a' }, b: { pattern: '^a' }, c: { pattern: '^a' } } },
      'applies patterns in more than 2 places',
    ],
    // ajv tests each patternProperties key again under additionalProperties: 2 keys, 4 places.
    // (A key whose schema is `{}` is tested only there, so the schemas here are not `{}`.)
    [
      'two patternProperties keys re-tested by additionalProperties: four places',
      {
        patternProperties: { '^a': { type: 'number' }, '^b': { type: 'number' } },
        additionalProperties: false,
      },
      'applies patterns in more than 2 places',
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

  it('the filter bounds: 2 places, and a total of two largest patterns', () => {
    expect([FILTER_MAX_PATTERN_PLACES, FILTER_PATTERNS_MAX_TOTAL_SIZE]).toEqual([2, 512]);
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

  it('one patternProperties key re-tested by additionalProperties (two places) is applied', () => {
    const f = compile({
      patternProperties: { '^n_': { type: 'number' } },
      additionalProperties: false,
    })!;
    expect([f({ n_a: 1 }), f({ n_a: 'text' }), f({ s: 1 })]).toEqual([true, false, false]);
  });

  // ajv's meta-schema holds patterns of its own (4 asks); they must not count against the bound.
  it('2 distinct patterns, with a $id, are applied', () => {
    const f = compile({
      $id: 'urn:example:filter',
      properties: { p0: { pattern: '^0' }, p1: { pattern: '^1' } },
    })!;
    expect([f({ p0: '0', p1: '1' }), f({ p0: '0', p1: '2' })]).toEqual([true, false]);
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

// The values below are built from the literal 16384, not from FILTER_PATTERN_MAX_INPUT_LENGTH, so
// moving the bound either way fails a test here. `^a` matches any run of `a` whatever its length,
// so the bound is the only reason a value over it is not matched.
describe('🔴 a pattern is not run on a value longer than the input bound', () => {
  const atBound = 'a'.repeat(16384);
  const overBound = 'a'.repeat(16385);

  it('the bound is 16384', () => {
    expect(FILTER_PATTERN_MAX_INPUT_LENGTH).toBe(16384);
  });

  it('^a matches a value of exactly 16384; one of 16385 is not matched and re2js is not run', () => {
    const rx = compileFilterPattern('^a');
    // Spied after the compile, whose self-test matches through re2js too.
    const re2Test = vi.spyOn(RE2JS.prototype, 'test');
    try {
      expect([rx.test(atBound), rx.test(overBound)]).toEqual([true, false]);
      expect(re2Test).toHaveBeenCalledTimes(1);
    } finally {
      re2Test.mockRestore();
    }
  });

  // An astral code point is two UTF-16 code units: 8192 of them are 16384 units, 8192 code points.
  it('the length is counted in UTF-16 code units, not code points', () => {
    const rx = compileFilterPattern('^\\u{1F600}');
    const astral = '\u{1F600}'.repeat(8192);
    expect(astral.length).toBe(16384);
    expect([rx.test(astral), rx.test(`${astral}a`)]).toEqual([true, false]);
  });

  describe('through a compiled filter, the pattern keyword fails on an oversized value', () => {
    const compile = createFilterCompiler();

    it('pattern: 16384 matches, 16385 does not', () => {
      const f = compile({ properties: { text: { pattern: '^a' } } })!;
      expect([f({ text: atBound }), f({ text: overBound })]).toEqual([true, false]);
    });

    it('not: {pattern} PASSES for an oversized value, and fails at the bound', () => {
      const f = compile({ properties: { text: { not: { pattern: '^a' } } } })!;
      expect([f({ text: atBound }), f({ text: overBound }), f({ text: 'b' })]).toEqual([
        false,
        true,
        true,
      ]);
    });

    it('patternProperties: a key over the bound is matched by no key, so additionalProperties applies', () => {
      const f = compile({
        patternProperties: { '^a': { type: 'number' } },
        additionalProperties: false,
      })!;
      expect([f({ [atBound]: 1 }), f({ [overBound]: 1 })]).toEqual([true, false]);
    });

    it('propertyNames: a name over the bound does not match its pattern', () => {
      const f = compile({ propertyNames: { pattern: '^a' } })!;
      expect([f({ [atBound]: 1 }), f({ [overBound]: 1 })]).toEqual([true, false]);
    });
  });
});

// Built from literals (65536 = 4 × 16384), not from FILTER_PATTERN_BODY_BUDGET, so moving the
// budget fails a test here. Every value is at the per-value bound (16384), so only the budget is
// at stake.
describe('🔴 one body evaluation runs at most 65536 characters of pattern input', () => {
  const A = 'a'.repeat(16384);
  const B = 'b'.repeat(16384);

  it('the budget is 65536', () => {
    expect(FILTER_PATTERN_BODY_BUDGET).toBe(65536);
  });

  it('items: 4 values of 16384 spend it exactly and match; a 5th is not matched, and not run', () => {
    const f = createFilterCompiler()({ properties: { tags: { items: { pattern: '^a' } } } })!;
    const re2Test = vi.spyOn(RE2JS.prototype, 'test');
    try {
      expect(f({ tags: [A, A, A, A] })).toBe(true);
      expect(re2Test).toHaveBeenCalledTimes(4);
      re2Test.mockClear();
      expect(f({ tags: [A, A, A, A, 'a'] })).toBe(false);
      expect(re2Test).toHaveBeenCalledTimes(4);
    } finally {
      re2Test.mockRestore();
    }
  });

  it('a value after the budget is spent counts as not matching: not: {pattern} passes for it', () => {
    const f = createFilterCompiler()({
      properties: { tags: { items: { not: { pattern: '^a' } } } },
    })!;
    // `a` matches ^a, so `not` fails for it while the budget lasts, and passes once it is spent.
    expect([f({ tags: [B, B, B, 'a'] }), f({ tags: [B, B, B, B, 'a'] })]).toEqual([false, true]);
  });

  it('a value that does not fit ends the budget: a shorter value after it is not matched either', () => {
    const f = createFilterCompiler()({
      properties: { tags: { items: { not: { pattern: '^a' } } } },
    })!;
    const b10k = 'b'.repeat(10000);
    // After three B, 16384 is left: one b10k fits, the second does not, and then `a` (which would
    // fit in the 6384 still unspent) is not matched, so `not` passes for it.
    expect(f({ tags: [B, B, B, b10k, b10k, 'a'] })).toBe(true);
  });

  it("two patterns share one body's budget: 3 + 1 values match, 3 + 2 do not", () => {
    const f = createFilterCompiler()({
      properties: { a: { items: { pattern: '^a' } }, b: { items: { pattern: '^b' } } },
    })!;
    expect([f({ a: [A, A, A], b: [B] }), f({ a: [A, A, A], b: [B, B] })]).toEqual([true, false]);
  });

  it('a value over the per-value bound charges nothing: it never runs', () => {
    const over = 'a'.repeat(16385);
    // Each `over` fails the pattern and passes minLength; the four A then spend the whole budget.
    const f = createFilterCompiler()({
      properties: { tags: { items: { anyOf: [{ pattern: '^a' }, { minLength: 16385 }] } } },
    })!;
    expect(f({ tags: [over, over, over, over, over, over, over, over, A, A, A, A] })).toBe(true);
  });

  it('each body gets a full budget: the same filter, body after body, even after one spent it', () => {
    const f = createFilterCompiler()({ properties: { tags: { items: { pattern: '^a' } } } })!;
    expect([
      f({ tags: [A, A, A, A] }),
      f({ tags: [A, A, A, A] }),
      f({ tags: [A, A, A, A, A] }),
      f({ tags: [A, A, A, A] }),
    ]).toEqual([true, true, false, true]);
  });

  it('a filter shared through the cache by two subscriptions: each body gets a full budget', () => {
    const compile = createFilterCompiler();
    const filter = { properties: { tags: { items: { pattern: '^a' } } } };
    const first = compile(filter)!;
    const second = compile(filter)!;
    expect(second).toBe(first);
    expect([
      first({ tags: [A, A, A, A, A] }),
      second({ tags: [A, A, A, A] }),
      first({ tags: [A, A, A, A] }),
    ]).toEqual([false, true, true]);
  });
});

describe('🔴 the body budget charges every run and is full for the first body', () => {
  const A = 'a'.repeat(16384);
  const B = 'b'.repeat(16384);

  it("an empty value after the budget is spent is not run: not: {pattern: '^$'} passes for it", () => {
    const f = createFilterCompiler()({
      properties: { tags: { items: { not: { pattern: '^$' } } } },
    })!;
    const re2Test = vi.spyOn(RE2JS.prototype, 'test');
    try {
      // Four B spend the budget; `a` does not fit and ends it; `''` would match ^$ if it ran.
      expect(f({ tags: [B, B, B, B, 'a', ''] })).toBe(true);
      expect(re2Test).toHaveBeenCalledTimes(4);
    } finally {
      re2Test.mockRestore();
    }
  });

  it('empty values cost 1 each: 65536 of them run, the 65537th does not', () => {
    const f = createFilterCompiler()({ properties: { tags: { items: { pattern: '^$' } } } })!;
    const re2Test = vi.spyOn(RE2JS.prototype, 'test');
    try {
      expect(f({ tags: new Array<string>(65536).fill('') })).toBe(true);
      expect(re2Test).toHaveBeenCalledTimes(65536);
      re2Test.mockClear();
      expect(f({ tags: new Array<string>(65537).fill('') })).toBe(false);
      expect(re2Test).toHaveBeenCalledTimes(65536);
    } finally {
      re2Test.mockRestore();
    }
  });

  // ajv's meta-schema runs a pattern on `$id` when the filter is compiled, through the same engine,
  // so the budget is part spent before the first body: it must be refilled before that body runs.
  it('a 7000-character $id spends budget at compile time; the first body still gets all of it', () => {
    const filter = {
      $id: `urn:example:${'x'.repeat(7000)}`,
      properties: { tags: { items: { pattern: '^a' } } },
    };
    expect(JSON.stringify(filter).length).toBeLessThan(8192);
    const f = createFilterCompiler()(filter)!;
    expect(f({ tags: [A, A, A, A] })).toBe(true);
  });
});
