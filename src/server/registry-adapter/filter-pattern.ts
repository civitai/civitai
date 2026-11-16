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
 *   - a `\p{...}` other than a General_Category short name (`\p{L}`, `\p{Lu}`, `gc=Lu`) or a
 *     script (`sc=Greek`, `Script=Greek`); a binary property or a long category name is refused;
 *   - a lone surrogate (`\uD800` not followed by its low half);
 *   - a counted repetition RE2 refuses (a count over 1000, or nested counts whose product is).
 * Bridged, so the meaning is ECMA's:
 *   - `.` excludes ECMA's line terminators (`\n`, `\r`, U+2028, U+2029), where RE2's excludes
 *     only `\n`;
 *   - `\s` and `\S` are ECMA's WhiteSpace and LineTerminator set (including `\v`, U+00A0, U+FEFF
 *     and the Zs spaces), where RE2's `\s` is ASCII;
 *   - escapes (`\uXXXX`, a surrogate pair, `\u{...}`, `\xXX`, `\cX`, `\0`) and every literal are
 *     written as code points, `[]` (matches nothing) and `[^]` (matches anything) as ranges.
 * Not bridged: `\p{...}` uses re2js's Unicode tables, which can be of another Unicode version
 * than the platform's, so a code point assigned in only one of them can match differently.
 * `\d`, `\w` and `\b` are ASCII in both (ECMA without the `i` flag).
 */

/** Longest `pattern` (or `patternProperties` key) a filter may hold, in UTF-16 code units. */
export const FILTER_PATTERN_MAX_LENGTH = 1024;

/** A pattern this source will not evaluate. Its message is the `bad_request` sent. */
export class FilterPatternError extends Error {}

/** ECMA-262's WhiteSpace and LineTerminator code points (`\s`), as the inside of an RE2 class. */
const WHITESPACE =
  '\\x{9}-\\x{D}\\x{20}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}';

/** ECMA's `.` without the `s` flag: anything but a line terminator. */
const DOT = '[^\\x{A}\\x{D}\\x{2028}\\x{2029}]';

const ANYTHING = '\\x{0}-\\x{10FFFF}';

/** General_Category short names, as both ECMA and RE2 spell them. */
const GENERAL_CATEGORIES: ReadonlySet<string> = new Set(
  (
    'L Lu Ll Lt Lm Lo M Mn Mc Me N Nd Nl No P Pc Pd Ps Pe Pi Pf Po ' +
    'S Sm Sc Sk So Z Zs Zl Zp C Cc Cf Cs Co'
  ).split(' ')
);

const SYNTAX_CHARACTERS = '^$\\.*+?()[]{}|/';

/** An escape: one code point, or a class (`out` outside a class, `inside` within one). */
type Escape =
  | { kind: 'char'; codePoint: number }
  | { kind: 'class'; out: string; inside: string | null }
  | { kind: 'assertion'; out: string };

/**
 * `pattern`, an ECMA-262 regular expression with the `u` flag, as an RE2 expression of the same
 * meaning; throws {@link FilterPatternError} for one that is not valid ECMA-262 or that has no
 * RE2 equivalent here. The input is validated by the platform parser first (parsing does no
 * matching, so it is not where backtracking costs), so the walk below only sees well-formed
 * syntax; anything it does not recognise is refused rather than passed through.
 */
export function translateFilterPattern(pattern: string): string {
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

  const propertyClass = (body: string, negated: boolean) => {
    const eq = body.indexOf('=');
    const [name, value] = eq < 0 ? [null, body] : [body.slice(0, eq), body.slice(eq + 1)];
    let re2Name: string | null = null;
    if (
      (name === null || name === 'gc' || name === 'General_Category') &&
      GENERAL_CATEGORIES.has(value)
    ) {
      re2Name = value;
    } else if ((name === 'sc' || name === 'Script') && /^[A-Za-z_]+$/.test(value)) {
      re2Name = value;
    }
    if (re2Name === null) return refuse(`the Unicode property escape \\p{${body}}`);
    return `\\${negated ? 'P' : 'p'}{${re2Name}}`;
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
      case 'P': {
        const close = cps.indexOf('}', i);
        const body = cps.slice(i + 1, close).join('');
        i = close + 1;
        const re2 = propertyClass(body, c === 'P');
        return { kind: 'class', out: re2, inside: re2 };
      }
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

  let out = '';
  while (i < cps.length) {
    const c = at(0);
    if (c === '\\') {
      const e = readEscape(false);
      out += e.kind === 'char' ? hex(e.codePoint) : e.out;
    } else if (c === '[') {
      out += readClass();
    } else if (c === '(') {
      if (at(1) !== '?') {
        out += '(';
        i += 1;
      } else if (at(2) === ':') {
        out += '(?:';
        i += 3;
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
      } else {
        refuse('a pattern modifier');
      }
    } else if (c === '{') {
      // A quantifier: the `u` flag makes any other brace a syntax error.
      const close = cps.indexOf('}', i);
      out += cps.slice(i, close + 1).join('');
      i = close + 1;
    } else if (c === '.') {
      out += DOT;
      i += 1;
    } else if ('^$|*+?)'.includes(c)) {
      out += c;
      i += 1;
    } else {
      out += hex(c.codePointAt(0)!);
      i += 1;
    }
  }
  return out;
}

/** `pattern` compiled for unanchored, linear-time matching; throws {@link FilterPatternError}. */
export function compileFilterPattern(pattern: string): RegExpLike {
  const re2 = translateFilterPattern(pattern);
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
  return {
    // RE2JS `test` finds a match anywhere in the input, as ECMA's does: unanchored.
    test: (s: string) => compiled.test(s),
    // ajv keys a compiled pattern by `toString()` within one schema, so it must name the pattern.
    toString: () => `/${pattern}/u (re2)`,
  } as RegExpLike;
}

/**
 * An ajv `code.regExp` engine compiling with {@link compileFilterPattern}, each distinct pattern
 * once per engine (ajv asks again for each place a pattern appears). One engine serves one ajv
 * instance, which compiles one filter.
 */
export function filterRegExpEngine(): RegExpEngine {
  const compiled = new Map<string, RegExpLike>();
  const engine = (pattern: string) => {
    let rx = compiled.get(pattern);
    if (!rx) {
      rx = compileFilterPattern(pattern);
      compiled.set(pattern, rx);
    }
    return rx;
  };
  // ajv writes `code` into a validator's source only when generating standalone code, which a
  // filter never is.
  engine.code = 'filterRegExp';
  return engine;
}
