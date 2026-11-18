import type { RegExpEngine, RegExpLike } from 'ajv/dist/types';
import { RE2JS } from 're2js';

/**
 * The regular expressions of a request filter (`pattern`, `patternProperties`), evaluated in
 * linear time.
 *
 * A filter is evaluated synchronously, per entity and per poll, on the one event loop that serves
 * every stream, and its patterns are the consumer's. The platform RegExp backtracks, so a pattern
 * such as `^(a+)+$` takes time exponential in its input and would stall every stream. Here a
 * pattern is translated to RE2 syntax and run by re2js (a pure-JS port of RE2, so no native build
 * in the adapter image), whose matching is linear in the input for a given pattern.
 *
 * JSON Schema's `pattern` is an ECMA-262 regular expression, unanchored; ajv compiles it with the
 * `u` flag. {@link translateFilterPattern} accepts exactly the patterns `new RegExp(p, 'u')`
 * accepts that it can translate to the SAME meaning, and refuses every other one: a refused
 * pattern makes the filter `bad_request`, never ignored or guessed at (the registry spec's
 * Subscribe rule 6). Refused, because RE2 has no linear-time equivalent:
 *   - lookahead and lookbehind (`(?=`, `(?!`, `(?<=`, `(?<!`);
 *   - backreferences (`\1`, `\k<name>`);
 *   - pattern modifiers (`(?i:...)`);
 *   - `\S` inside a character class (ECMA's `\s` is Unicode-aware, RE2's is ASCII, and the
 *     complement cannot be written inside a class);
 *   - a Unicode property escape (`\p{...}`, `\P{...}`): re2js's Unicode tables can be of another
 *     Unicode version than the platform's, and spell some property names differently, so the
 *     same escape can mean another set of code points;
 *   - a lone surrogate (`\uD800` not followed by its low half);
 *   - a pattern whose size, with its counted repetitions multiplied out, is over
 *     {@link FILTER_PATTERN_MAX_SIZE} ({@link translateFilterPattern} says how it is counted).
 * Bridged, so the meaning is ECMA's:
 *   - `.` excludes ECMA's line terminators (`\n`, `\r`, U+2028, U+2029), where RE2's excludes
 *     only `\n`;
 *   - `\s` and `\S` are ECMA's WhiteSpace and LineTerminator set (including `\v`, U+00A0, U+FEFF
 *     and the Zs spaces), where RE2's `\s` is ASCII;
 *   - escapes (`\uXXXX`, a surrogate pair, `\u{...}`, `\xXX`, `\cX`, `\0`) and every literal are
 *     written as code points, `[]` (matches nothing) and `[^]` (matches anything) as ranges;
 *   - a count is written without leading zeros: ECMA reads `a{01}` as `a{1}`, RE2 as the literal
 *     text `a{01}`.
 * `\d`, `\w` and `\b` are ASCII in both (ECMA without the `i` flag).
 * Known gap, not bridged: `\B` at a position between the two halves of a surrogate pair in the
 * input. V8 can find `\B` there, where RE2 steps by code point and never stops between the
 * halves, so a pattern whose match depends on that position can differ.
 */

/** Longest `pattern` (or `patternProperties` key) a filter may hold, in UTF-16 code units. */
export const FILTER_PATTERN_MAX_LENGTH = 1024;

/**
 * Largest size a pattern may have, counted as {@link translateFilterPattern} says. Matching is
 * linear in the input with a factor of the size (the NFA can hold one thread per instruction), so
 * the size, not the length, is what a match costs: `.{1000}` written 146 times fits in 1022
 * characters and is size 146 000. A literal pattern's size is its length, so this also bounds
 * literals below the length bound. How the sizes bound a filter's pattern work is at
 * `FILTER_MAX_PATTERN_PLACES` (`json-schema.ts`).
 */
export const FILTER_PATTERN_MAX_SIZE = 256;

/**
 * Longest value a filter pattern is run on, in UTF-16 code units (`string.length`): a body string
 * for `pattern` (and `propertyNames`' `pattern`), a property name for `patternProperties` and the
 * `additionalProperties` that re-tests its keys. Matching is linear in the value's length, and
 * the strings a body holds have no length bound of their own, so this bounds the CPU a pattern
 * can spend per value: at most this length times the pattern's size.
 *
 * A longer value counts as not matching: the compiled pattern's `test` returns false without
 * running the engine ({@link compileFilterPattern}, the one object ajv calls `test` on). It is
 * the `pattern` keyword that fails, not the filter, so the result composes as a failed keyword
 * does: `not: {pattern: p}` PASSES for an oversized value whatever `p` is; an `anyOf` or `oneOf`
 * branch holding the pattern fails, so another branch decides; an `if` with the pattern takes the
 * `else`; a property name over the bound is matched by no `patternProperties` key, so
 * `additionalProperties` applies to it unless `properties` names it. A pattern filter over a
 * string longer than this (document text, say) therefore finds no match in it, not even one in
 * its first characters.
 *
 * ajv's meta-schema patterns, which validate the filter itself and never a body, are compiled
 * through the same engine and so carry the bound too; they never meet it, as no string in a filter
 * is longer than the filter's own bound as JSON (`FILTER_MAX_BYTES` in `json-schema.ts`).
 */
export const FILTER_PATTERN_MAX_INPUT_LENGTH = 16384;

/**
 * Most pattern input one body evaluation may run, in UTF-16 code units, summed over every value
 * any of the filter's patterns is run on. {@link FILTER_PATTERN_MAX_INPUT_LENGTH} bounds one value,
 * but one place runs its pattern on every value it applies to (`items: {pattern}`,
 * `additionalProperties: {pattern}`), so without this the work grew with the whole body. With it,
 * the pattern work per body is at most size × min(places × the body's charge, this budget), where
 * size is {@link FILTER_PATTERN_MAX_SIZE}, places is `FILTER_MAX_PATTERN_PLACES`
 * (`json-schema.ts`), and the body's charge sums max(1, length) over its string values and
 * property names.
 *
 * Each filter's engine ({@link filterRegExpEngine}) holds one budget, shared by all of the filter's
 * patterns, and refills it immediately before each body is validated
 * ({@link FilterRegExpEngine.metered}, the one call that runs the compiled filter). Validation is
 * synchronous, so no other body can run in between, and a filter shared by many subscriptions
 * through the filter cache refills it for each body it evaluates: the budget is per evaluation,
 * not per pattern or per subscription.
 *
 * Each run is charged its value's length, at least 1, so the number of runs is bounded too. A
 * value that does not fit is not matched (see {@link FILTER_PATTERN_MAX_INPUT_LENGTH} for how that
 * composes) and ends the budget for the rest of the body; which values come after follows ajv's
 * evaluation order.
 */
export const FILTER_PATTERN_BODY_BUDGET = 65536;

/** The pattern input left for the body being evaluated, shared by one filter's patterns. */
export type FilterPatternBudget = { remaining: number };

/** A pattern this source will not evaluate. Its message is the `bad_request` sent. */
export class FilterPatternError extends Error {}

/** ECMA-262's WhiteSpace and LineTerminator code points (`\s`), as the inside of an RE2 class. */
const WHITESPACE =
  '\\x{9}-\\x{D}\\x{20}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}';

/** ECMA's `.` without the `s` flag: anything but a line terminator. */
const DOT = '[^\\x{A}\\x{D}\\x{2028}\\x{2029}]';

const ANYTHING = '\\x{0}-\\x{10FFFF}';

const SYNTAX_CHARACTERS = '^$\\.*+?()[]{}|/';

/** An escape: one code point, or a class (`out` outside a class, `inside` within one). */
type Escape =
  | { kind: 'char'; codePoint: number }
  | { kind: 'class'; out: string; inside: string | null }
  | { kind: 'assertion'; out: string };

/**
 * `pattern`, an ECMA-262 regular expression with the `u` flag, as an RE2 expression of the same
 * meaning; throws {@link FilterPatternError} for one that is not valid ECMA-262, that has no RE2
 * equivalent here, or whose size is over {@link FILTER_PATTERN_MAX_SIZE}. The input is validated
 * by the platform parser first (parsing does no matching, so it is not where backtracking costs),
 * so the walk below only sees well-formed syntax; anything it does not recognise is refused rather
 * than passed through.
 */
export function translateFilterPattern(pattern: string): string {
  return translate(pattern).re2;
}

/**
 * {@link translateFilterPattern}, with the pattern's size: each atom (a code point, a class, `.`,
 * an escape, an assertion) and each `|` is 1, a group is 1 plus the sum of what it holds (so an
 * empty group repeated still counts), and a count multiplies the atom or group before it by its
 * largest repeat (`{n}` and `{n,m}` by the larger of n and m, `{n,}` by n, at least 1). `*`, `+`
 * and `?` multiply by 1, as RE2 compiles them to a loop. Nested counts multiply through, so
 * `(?:a{10}){10}` is 110 and `.{1000}` written twice is 2000. A literal pattern's size is its
 * length. RE2 compiles a pattern to about twice its size in instructions (measured: size 1001 to
 * 2003, 23 to 26), and the size is checked as it is counted, before anything is compiled.
 */
function translate(pattern: string): { re2: string; size: number } {
  const quoted = JSON.stringify(pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern);
  const refuse = (what: string): never => {
    throw new FilterPatternError(
      `filter pattern ${quoted} uses ${what}, which this registry does not apply ` +
        '(its linear-time regular expression engine has no equivalent)'
    );
  };
  if (pattern.length > FILTER_PATTERN_MAX_LENGTH) {
    throw new FilterPatternError(
      `filter pattern ${quoted} is longer than ${FILTER_PATTERN_MAX_LENGTH} characters, which this registry does not apply`
    );
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    throw new FilterPatternError(
      `filter pattern ${quoted} is not a valid ECMA-262 regular expression (with the u flag)`
    );
  }

  /** A code point as RE2 writes it; a surrogate (one the `u` flag leaves unpaired) is refused. */
  const hex = (codePoint: number) => {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) refuse('a lone surrogate');
    return `\\x{${codePoint.toString(16).toUpperCase()}}`;
  };

  const cps = Array.from(pattern);
  let i = 0;
  const at = (k: number) => cps[i + k] ?? '';

  const readHex = (from: number, count: number) => {
    const text = cps.slice(from, from + count).join('');
    return /^[0-9A-Fa-f]+$/.test(text) && text.length === count ? parseInt(text, 16) : null;
  };

  /** The escape at `i` (a backslash), consumed. */
  const readEscape = (inClass: boolean): Escape => {
    const c = at(1);
    i += 2;
    switch (c) {
      case 'd':
      case 'D':
      case 'w':
      case 'W':
        return { kind: 'class', out: `\\${c}`, inside: `\\${c}` };
      case 's':
        return { kind: 'class', out: `[${WHITESPACE}]`, inside: WHITESPACE };
      case 'S':
        return { kind: 'class', out: `[^${WHITESPACE}]`, inside: null };
      case 'b':
        return inClass ? { kind: 'char', codePoint: 8 } : { kind: 'assertion', out: '\\b' };
      case 'B':
        return { kind: 'assertion', out: '\\B' };
      case 't':
        return { kind: 'char', codePoint: 9 };
      case 'n':
        return { kind: 'char', codePoint: 10 };
      case 'v':
        return { kind: 'char', codePoint: 11 };
      case 'f':
        return { kind: 'char', codePoint: 12 };
      case 'r':
        return { kind: 'char', codePoint: 13 };
      case '0':
        return { kind: 'char', codePoint: 0 };
      case 'c': {
        const letter = at(0);
        i += 1;
        return { kind: 'char', codePoint: letter.charCodeAt(0) % 32 };
      }
      case 'x': {
        const value = readHex(i, 2);
        if (value === null) return refuse('an escape it does not recognise');
        i += 2;
        return { kind: 'char', codePoint: value };
      }
      case 'u': {
        let value: number | null;
        if (at(0) === '{') {
          const close = cps.indexOf('}', i);
          value = close < 0 ? null : readHex(i + 1, close - i - 1);
          i = close + 1;
        } else {
          value = readHex(i, 4);
          i += 4;
          // A surrogate pair written as two escapes is one code point (the `u` flag).
          if (
            value !== null &&
            value >= 0xd800 &&
            value <= 0xdbff &&
            at(0) === '\\' &&
            at(1) === 'u'
          ) {
            const low = readHex(i + 2, 4);
            if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
              value = 0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00);
              i += 6;
            }
          }
        }
        if (value === null) return refuse('an escape it does not recognise');
        return { kind: 'char', codePoint: value };
      }
      case 'p':
      case 'P':
        return refuse('a Unicode property escape');
      case 'k':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        return refuse('a backreference');
      default:
        if (c === '-' || SYNTAX_CHARACTERS.includes(c)) {
          return { kind: 'char', codePoint: c.codePointAt(0)! };
        }
        return refuse('an escape it does not recognise');
    }
  };

  /** The class at `i` (a `[`), consumed, as RE2. */
  const readClass = () => {
    i += 1;
    const negated = at(0) === '^';
    if (negated) i += 1;
    let members = '';
    while (i < cps.length && at(0) !== ']') {
      let atom: Escape;
      if (at(0) === '\\') atom = readEscape(true);
      else {
        atom = { kind: 'char', codePoint: at(0).codePointAt(0)! };
        i += 1;
      }
      if (atom.kind === 'char' && at(0) === '-' && at(1) !== ']' && at(1) !== '') {
        i += 1;
        let end: Escape;
        if (at(0) === '\\') end = readEscape(true);
        else {
          end = { kind: 'char', codePoint: at(0).codePointAt(0)! };
          i += 1;
        }
        // The `u` flag makes a range with a class at either end a syntax error.
        if (end.kind !== 'char') return refuse('a character class range it does not recognise');
        members += `${hex(atom.codePoint)}-${hex(end.codePoint)}`;
      } else if (atom.kind === 'char') {
        members += hex(atom.codePoint);
      } else if (atom.kind === 'class') {
        if (atom.inside === null) return refuse('\\S inside a character class');
        members += atom.inside;
      } else {
        return refuse('an assertion inside a character class');
      }
    }
    i += 1; // the `]`
    // `[]` matches nothing and `[^]` anything; RE2 has no empty class.
    if (members === '') return negated ? `[${ANYTHING}]` : `[^${ANYTHING}]`;
    return `[${negated ? '^' : ''}${members}]`;
  };

  /**
   * The size counted so far, one entry per open group (the outermost is the pattern): `sum` is
   * what the group holds, `last` the size of its latest atom, which a following count multiplies.
   */
  const sizes: Array<{ sum: number; last: number }> = [{ sum: 0, last: 0 }];
  const top = () => sizes[sizes.length - 1];
  const tooBig = () =>
    new FilterPatternError(
      `filter pattern ${quoted} is larger than ${FILTER_PATTERN_MAX_SIZE} once its counted ` +
        'repetitions are multiplied out (a{n} counts as n copies of a), which this registry does not apply'
    );
  // Checked at every step, so no size ever grows past the bound (nor to Infinity, which a later
  // `{0}` would turn into NaN).
  const grow = (sum: number, last: number) => {
    if (sum > FILTER_PATTERN_MAX_SIZE || last > FILTER_PATTERN_MAX_SIZE) throw tooBig();
    top().sum = sum;
    top().last = last;
  };
  const atom = (size: number) => grow(top().sum + size, size);
  const openGroup = () => sizes.push({ sum: 0, last: 0 });

  let out = '';
  while (i < cps.length) {
    const c = at(0);
    if (c === '\\') {
      const e = readEscape(false);
      out += e.kind === 'char' ? hex(e.codePoint) : e.out;
      atom(1);
    } else if (c === '[') {
      out += readClass();
      atom(1);
    } else if (c === '(') {
      if (at(1) !== '?') {
        out += '(';
        i += 1;
        openGroup();
      } else if (at(2) === ':') {
        out += '(?:';
        i += 3;
        openGroup();
      } else if (at(2) === '=' || at(2) === '!') {
        refuse('a lookahead');
      } else if (at(2) === '<' && (at(3) === '=' || at(3) === '!')) {
        refuse('a lookbehind');
      } else if (at(2) === '<') {
        const close = cps.indexOf('>', i);
        const name = cps.slice(i + 3, close).join('');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          refuse(`the group name ${JSON.stringify(name)}`);
        out += `(?P<${name}>`;
        i = close + 1;
        openGroup();
      } else {
        refuse('a pattern modifier');
      }
    } else if (c === '{') {
      // A quantifier: the `u` flag makes any other brace a syntax error, so this is `{n}`, `{n,}`
      // or `{n,m}`. Its counts are written back as plain integers: RE2 reads a count with a
      // leading zero (`{01}`) as literal text, where ECMA reads it as the number.
      const close = cps.indexOf('}', i);
      const counts = /^(\d+)(,(\d*))?$/.exec(cps.slice(i + 1, close).join(''));
      if (!counts) return refuse('a quantifier it does not recognise');
      const min = Number(counts[1]);
      const max = counts[3] ? Number(counts[3]) : null;
      const times = counts[2] === undefined ? min : max === null ? Math.max(min, 1) : max;
      const { sum, last } = top();
      // The latest atom is now `times` copies of itself. A count over the bound is refused on its
      // own, so `last * times` is never 0 * Infinity.
      if (times > FILTER_PATTERN_MAX_SIZE || last * times > FILTER_PATTERN_MAX_SIZE) throw tooBig();
      grow(sum - last + last * times, last * times);
      out += counts[2] === undefined ? `{${min}}` : max === null ? `{${min},}` : `{${min},${max}}`;
      i = close + 1;
    } else if (c === ')') {
      const group = sizes.pop()!;
      out += c;
      i += 1;
      atom(group.sum + 1);
    } else if (c === '.') {
      out += DOT;
      i += 1;
      atom(1);
    } else if ('^$'.includes(c)) {
      out += c;
      i += 1;
      atom(1);
    } else if (c === '|') {
      out += c;
      i += 1;
      grow(top().sum + 1, 0);
    } else if ('*+?'.includes(c)) {
      // `*`, `+` and `?` (also the lazy mark after a count) multiply by 1.
      out += c;
      i += 1;
    } else {
      out += hex(c.codePointAt(0)!);
      i += 1;
      atom(1);
    }
  }
  return { re2: out, size: sizes[0].sum };
}

/**
 * Most memory, in re2js's own estimate, the DFA of one compiled pattern may hold: 32 KiB, where
 * re2js's default is 8 MiB. re2js builds a pattern's DFA lazily on its first match and keeps it for
 * the pattern's lifetime; a filter predicate lives as long as its subscription, and a caller can
 * open many subscriptions with distinct filters, so at the default each live pattern could keep
 * ~5-8 MB. A DFA over its budget clears its cache and, if that happens too often, re2js runs the
 * pattern on its NFA instead, in the same linear time the size bounds already assume.
 *
 * 32 KiB is the smallest budget measured that kept realistic patterns (a
 * `^urn:schema:civitai.com:` prefix, a slug, a five-word alternation) at the default's speed;
 * smaller budgets ran them markedly slower, so do not lower it.
 */
export const FILTER_PATTERN_DFA_BYTES = 32 * 1024;

/** The DFA fields of re2js 2.9.1 that {@link boundDfa} reads: the budget, and what enforces it. */
type Re2jsDfa = {
  maxMem?: number;
  stateBudget?: number;
  memBudget?: number;
  clearCache?: (...args: unknown[]) => unknown;
};

/** The parts of re2js 2.9.1's internal state that {@link boundDfa} reads and writes. */
type Re2jsInternals = {
  re2Input?: {
    prog?: unknown;
    lazyDFA?: Re2jsDfa | null;
    readonly dfa?: { constructor: new (prog: unknown, maxMem: number) => Re2jsDfa };
  };
};

/**
 * Puts a DFA of {@link FILTER_PATTERN_DFA_BYTES} where re2js keeps a pattern's lazy one, built
 * with re2js's own DFA class (its constructor takes the program and the budget); the DFA, or null
 * when re2js's internals are not where 2.9.1 has them.
 */
function installBoundedDfa(compiled: RE2JS): Re2jsDfa | null {
  const re2 = (compiled as unknown as Re2jsInternals).re2Input;
  const Dfa = re2 && 'lazyDFA' in re2 && re2.prog ? re2.dfa?.constructor : undefined;
  if (!re2 || !Dfa) return null;
  re2.lazyDFA = new Dfa(re2.prog, FILTER_PATTERN_DFA_BYTES);
  return re2.lazyDFA;
}

/**
 * Whether `dfa` holds the bound in the fields re2js enforces it with: `stateBudget` (what a
 * cleared cache gets back) and `memBudget` (what is left), not only `maxMem`, which re2js keeps
 * but does not check a state against.
 */
function enforcesBound(dfa: Re2jsDfa | null | undefined): boolean {
  const fields = [dfa?.maxMem, dfa?.stateBudget, dfa?.memBudget];
  return (
    dfa?.maxMem === FILTER_PATTERN_DFA_BYTES &&
    fields.every((v) => typeof v === 'number' && v >= 0 && v <= FILTER_PATTERN_DFA_BYTES)
  );
}

/** {@link dfaSelfTest}'s pattern: its DFA has up to 2^21 states, so a short input overflows. */
const SELF_TEST_PATTERN = '[ab]*a[ab]{20}$';

/**
 * 256 code points of `a` and `b` from a fixed seed: long enough that a
 * {@link FILTER_PATTERN_DFA_BYTES} DFA for {@link SELF_TEST_PATTERN} clears its cache at least
 * once. Its 21st code point from the end is `b`, so the pattern does not match.
 */
const SELF_TEST_INPUT = (() => {
  let x = 1;
  let out = '';
  for (let k = 0; k < 256; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += x & 0x10000 ? 'a' : 'b';
  }
  return out;
})();

/**
 * Whether re2js really runs a pattern on the bounded DFA {@link installBoundedDfa} gives it, and
 * enforces its budget. Reading the fields cannot show that: a re2js that kept the budget fields at
 * its default, or that matched with a DFA of its own and left the installed one unused, would pass
 * a field check and keep megabytes per pattern. So this matches {@link SELF_TEST_PATTERN} against
 * {@link SELF_TEST_INPUT}, which overflows the bound, and asks for the observable effects: the
 * installed DFA is still the one in place, it cleared its cache at least once (it ran, and hit the
 * bound), it is still within the bound, and the verdict is the right one.
 */
export function dfaSelfTest(): boolean {
  const probe = RE2JS.compile(SELF_TEST_PATTERN);
  const dfa = installBoundedDfa(probe);
  if (!enforcesBound(dfa) || typeof dfa?.clearCache !== 'function') return false;
  const clear = dfa.clearCache;
  let cleared = 0;
  dfa.clearCache = function (this: unknown, ...args: unknown[]) {
    cleared += 1;
    return clear.apply(this, args);
  };
  const verdict = probe.test(SELF_TEST_INPUT);
  const installed = (probe as unknown as Re2jsInternals).re2Input?.lazyDFA;
  return verdict === false && cleared >= 1 && installed === dfa && enforcesBound(dfa);
}

/**
 * Gives `compiled` a DFA of {@link FILTER_PATTERN_DFA_BYTES}. re2js has no public option for it
 * (`RE2JS#reset()` clears only its matcher pool), so {@link installBoundedDfa} puts one where re2js
 * keeps the lazy one, which it then uses for every match. re2js is pinned exactly (`package.json`).
 * The pattern is refused ({@link FilterPatternError}, so `bad_request`) rather than applied with an
 * unbounded DFA when the installed DFA does not hold the bound in its enforced fields
 * ({@link enforcesBound}), or when {@link dfaSelfTest} fails; the self-test runs on every compile,
 * so nothing about it is cached or depends on which pattern was compiled first.
 */
function boundDfa(compiled: RE2JS): void {
  if (!enforcesBound(installBoundedDfa(compiled)) || !dfaSelfTest()) {
    throw new FilterPatternError(
      "this registry cannot apply filter patterns: its regular expression engine's internals changed"
    );
  }
}

/** The DFA budget `compiled` has now, read from re2js; for tests. */
function dfaBudget(compiled: RE2JS): number | undefined {
  return (compiled as unknown as Re2jsInternals).re2Input?.lazyDFA?.maxMem;
}

/**
 * A compiled pattern, with its size as {@link translateFilterPattern} counts it and the DFA
 * budget its engine has (read live, so a test sees what re2js will use).
 */
export type CompiledFilterPattern = RegExpLike & {
  readonly size: number;
  readonly dfaBytes: number | undefined;
};

/**
 * `pattern` compiled for unanchored, linear-time matching; throws {@link FilterPatternError}. Its
 * `test` is false, without matching, for a value longer than
 * {@link FILTER_PATTERN_MAX_INPUT_LENGTH}, and, given a `budget`, for a value that does not fit in
 * it ({@link FILTER_PATTERN_BODY_BUDGET}).
 */
export function compileFilterPattern(
  pattern: string,
  budget?: FilterPatternBudget
): CompiledFilterPattern {
  const { re2, size } = translate(pattern);
  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(re2);
  } catch (err) {
    const why = err instanceof Error ? `: ${err.message}` : '';
    throw new FilterPatternError(
      `filter pattern ${JSON.stringify(
        pattern.slice(0, 80)
      )} cannot be compiled by this registry's ` + `linear-time regular expression engine${why}`
    );
  }
  boundDfa(compiled);
  return {
    // RE2JS `test` finds a match anywhere in the input, as ECMA's does: unanchored. A value over
    // FILTER_PATTERN_MAX_INPUT_LENGTH, or one the budget cannot pay for, is not matched, and the
    // engine is not run on it.
    test: (s: string) => {
      if (s.length > FILTER_PATTERN_MAX_INPUT_LENGTH) return false;
      if (budget) {
        const charge = Math.max(1, s.length);
        if (charge > budget.remaining) {
          budget.remaining = 0;
          return false;
        }
        budget.remaining -= charge;
      }
      return compiled.test(s);
    },
    // ajv keys a compiled pattern by `toString()` within one schema, so it must name the pattern.
    toString: () => `/${pattern}/u (re2)`,
    size,
    get dfaBytes() {
      return dfaBudget(compiled);
    },
  } as CompiledFilterPattern;
}

/**
 * An ajv `code.regExp` engine that counts only once armed, and says how many distinct patterns
 * it compiled for the filter. `metered(run)` refills the filter's
 * {@link FILTER_PATTERN_BODY_BUDGET} and then calls `run`, which validates one body.
 */
export type FilterRegExpEngine = RegExpEngine & {
  arm: () => void;
  distinct: () => number;
  metered: <T>(run: () => T) => T;
};

/**
 * An ajv `code.regExp` engine compiling with {@link compileFilterPattern}, each distinct pattern
 * once per engine. One engine serves one ajv instance, which compiles one filter.
 *
 * ajv asks for a pattern once for each place it is applied (a `pattern`, a `patternProperties`
 * key, and that key again under `additionalProperties`), and each place runs it once per value
 * it applies to. Every ask is a place, a repeated pattern counted each time. A filter with more
 * than `maxPlaces` places, or whose sizes summed over its places exceed `maxTotalSize`, throws
 * {@link FilterPatternError}. Each place runs its pattern once per value it applies to, so the
 * places and sizes bound the work per character; {@link FILTER_PATTERN_BODY_BUDGET} bounds the
 * characters per body.
 *
 * Nothing is counted before {@link FilterRegExpEngine.arm}: ajv compiles its meta-schema's own
 * patterns (for `$id`, `$anchor` and the like) through the same engine, the first time it
 * validates a schema, and those are not the filter's.
 */
export function filterRegExpEngine({
  maxTotalSize,
  maxPlaces,
}: {
  maxTotalSize: number;
  maxPlaces: number;
}): FilterRegExpEngine {
  const compiled = new Map<string, CompiledFilterPattern>();
  const counted = new Set<string>();
  let armed = false;
  let places = 0;
  let total = 0;
  // One budget for every pattern this engine compiles (the meta-schema's too, so a filter pattern
  // that happens to equal one of those, and so shares its compiled object, is still charged).
  const budget: FilterPatternBudget = { remaining: FILTER_PATTERN_BODY_BUDGET };
  const engine = (pattern: string) => {
    if (armed) {
      places += 1;
      if (places > maxPlaces) {
        throw new FilterPatternError(
          `filter applies patterns in more than ${maxPlaces} places (each pattern and ` +
            'patternProperties key counts, and a patternProperties key again under ' +
            'additionalProperties), which this registry does not apply'
        );
      }
      counted.add(pattern);
    }
    let rx = compiled.get(pattern);
    if (!rx) {
      rx = compileFilterPattern(pattern, budget);
      compiled.set(pattern, rx);
    }
    if (!armed) return rx;
    total += rx.size;
    if (total > maxTotalSize) {
      throw new FilterPatternError(
        `filter's patterns are larger than ${maxTotalSize} in total, counting each place a ` +
          'pattern is applied and its counted repetitions multiplied out, which this registry does not apply'
      );
    }
    return rx;
  };
  engine.arm = () => {
    armed = true;
  };
  engine.distinct = () => counted.size;
  engine.metered = <T>(run: () => T): T => {
    budget.remaining = FILTER_PATTERN_BODY_BUDGET;
    return run();
  };
  // ajv writes `code` into a validator's source only when generating standalone code, which a
  // filter never is.
  engine.code = 'filterRegExp';
  return engine;
}
