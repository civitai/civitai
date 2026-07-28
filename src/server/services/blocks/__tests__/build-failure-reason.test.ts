import { describe, expect, it } from 'vitest';
import {
  BUILD_FAILURE_TRUNCATION_MARKER,
  MAX_BUILD_FAILURE_REASON_CHARS,
  buildFailureDeployDetail,
  sanitizeBuildFailureReason,
} from '../build-failure-reason';

/**
 * The build-failure excerpt is TENANT-INFLUENCED build output that reaches us over
 * an authenticated channel. Authentication proves WHO sent it, never that the
 * CONTENT is safe — so the sanitizer is the boundary and every one of its
 * guarantees is pinned here.
 *
 * Control characters are built from `String.fromCharCode` so this test file, like
 * the module it covers, contains no raw control bytes.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const CSI8 = String.fromCharCode(0x9b);
const C1 = String.fromCharCode(0x85);

/** Every code point in `s` that is neither `\n` nor printable (0x20..0x7E, >=0xA0). */
function disallowedChars(s: string): number[] {
  const bad: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) continue;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) bad.push(c);
  }
  return bad;
}

describe('sanitizeBuildFailureReason — non-string / empty input', () => {
  it('returns undefined for anything that is not a string', () => {
    expect(sanitizeBuildFailureReason(undefined)).toBeUndefined();
    expect(sanitizeBuildFailureReason(null)).toBeUndefined();
    expect(sanitizeBuildFailureReason(42)).toBeUndefined();
    expect(sanitizeBuildFailureReason(true)).toBeUndefined();
    expect(sanitizeBuildFailureReason({ toString: () => 'boom' })).toBeUndefined();
    expect(sanitizeBuildFailureReason(['boom'])).toBeUndefined();
  });

  it('returns undefined for empty / whitespace-only input', () => {
    expect(sanitizeBuildFailureReason('')).toBeUndefined();
    expect(sanitizeBuildFailureReason('   ')).toBeUndefined();
    expect(sanitizeBuildFailureReason('\n\n\n')).toBeUndefined();
    expect(sanitizeBuildFailureReason(' \t \r\n  \n ')).toBeUndefined();
  });

  it('returns undefined when the input is ONLY escape sequences / control chars', () => {
    expect(sanitizeBuildFailureReason(`${ESC}[0m${ESC}[1;31m`)).toBeUndefined();
    expect(sanitizeBuildFailureReason(`${NUL}${DEL}${C1}`)).toBeUndefined();
  });
});

describe('sanitizeBuildFailureReason — the real-world happy path', () => {
  it('passes an ordinary build error through verbatim', () => {
    const msg =
      'ERROR: no package-lock.json is committed. Commit your lockfile — `npm install` then commit.';
    expect(sanitizeBuildFailureReason(msg)).toBe(msg);
  });

  it('preserves interior newlines and the shape of a multi-line log', () => {
    const msg = 'ERROR: build failed\n  at Object.<anonymous> (index.ts:3:9)\n  exit code 1';
    expect(sanitizeBuildFailureReason(msg)).toBe(msg);
  });
});

describe('sanitizeBuildFailureReason — escape sequences', () => {
  it('strips CSI/SGR colour codes but keeps the text they wrapped', () => {
    const out = sanitizeBuildFailureReason(`${ESC}[1;31mERROR${ESC}[0m: missing lockfile`);
    expect(out).toBe('ERROR: missing lockfile');
    expect(out).not.toContain('[1;31m');
    expect(out).not.toContain('[0m');
  });

  it('strips an OSC window-title sequence (BEL-terminated)', () => {
    const out = sanitizeBuildFailureReason(`${ESC}]0;pwned${BEL}build failed`);
    expect(out).toBe('build failed');
    expect(out).not.toContain('pwned');
  });

  it('strips an OSC sequence terminated by ST (ESC backslash)', () => {
    const out = sanitizeBuildFailureReason(`${ESC}]8;;https://evil.example${ESC}\\click`);
    expect(out).toBe('click');
    expect(out).not.toContain('evil.example');
  });

  it('strips an UNTERMINATED OSC sequence (nothing is left dangling)', () => {
    expect(sanitizeBuildFailureReason(`before ${ESC}]0;never-closed`)).toBe('before');
  });

  it('strips an 8-bit CSI introducer', () => {
    expect(sanitizeBuildFailureReason(`${CSI8}31mred text`)).toBe('red text');
  });

  it('strips two-character escapes and a lone trailing ESC', () => {
    expect(sanitizeBuildFailureReason(`${ESC}(Bplain${ESC}`)).toBe('plain');
  });

  it('strips cursor-movement / erase sequences that would rewrite the terminal', () => {
    expect(sanitizeBuildFailureReason(`line one${ESC}[2K${ESC}[1Aoverwrite`)).toBe(
      'line oneoverwrite'
    );
  });
});

describe('sanitizeBuildFailureReason — control characters', () => {
  it('drops NUL, DEL, VT/FF and C1 controls', () => {
    const out = sanitizeBuildFailureReason(
      `a${NUL}b${DEL}c${String.fromCharCode(0x0b)}d${String.fromCharCode(0x0c)}e${C1}f`
    );
    expect(out).toBe('abcdef');
  });

  it('converts CRLF to LF and DROPS a bare CR', () => {
    expect(sanitizeBuildFailureReason('one\r\ntwo')).toBe('one\ntwo');
    expect(sanitizeBuildFailureReason('one\rtwo')).toBe('onetwo');
    expect(sanitizeBuildFailureReason('progress\rdone')).not.toContain('\r');
  });

  it('converts tabs to spaces (word separation preserved)', () => {
    expect(sanitizeBuildFailureReason('key\tvalue')).toBe('key value');
    expect(sanitizeBuildFailureReason('a\t\tb')).toBe('a  b');
  });

  it('keeps newline as the ONE surviving control character', () => {
    const out = sanitizeBuildFailureReason('a\nb') as string;
    expect(out).toBe('a\nb');
    expect(disallowedChars(out)).toEqual([]);
  });
});

describe('sanitizeBuildFailureReason — whitespace normalization', () => {
  it('collapses runs of blank lines to a single blank line', () => {
    expect(sanitizeBuildFailureReason('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('keeps a single blank line as-is', () => {
    expect(sanitizeBuildFailureReason('a\n\nb')).toBe('a\n\nb');
  });

  it('strips trailing spaces on each line', () => {
    expect(sanitizeBuildFailureReason('a   \nb  \nc')).toBe('a\nb\nc');
  });

  it('trims leading/trailing whitespace of the whole excerpt', () => {
    expect(sanitizeBuildFailureReason('\n\n  real message  \n\n')).toBe('real message');
  });
});

describe('sanitizeBuildFailureReason — truncation boundary', () => {
  it('leaves an excerpt exactly AT the cap untouched (no marker)', () => {
    const atCap = 'x'.repeat(MAX_BUILD_FAILURE_REASON_CHARS);
    const out = sanitizeBuildFailureReason(atCap) as string;
    expect(out).toBe(atCap);
    expect(out.length).toBe(MAX_BUILD_FAILURE_REASON_CHARS);
    expect(out.endsWith(BUILD_FAILURE_TRUNCATION_MARKER)).toBe(false);
  });

  it('truncates ONE char over the cap and marks it', () => {
    const overCap = 'x'.repeat(MAX_BUILD_FAILURE_REASON_CHARS + 1);
    const out = sanitizeBuildFailureReason(overCap) as string;
    expect(out.length).toBe(MAX_BUILD_FAILURE_REASON_CHARS);
    expect(out.endsWith(BUILD_FAILURE_TRUNCATION_MARKER)).toBe(true);
  });

  it('never exceeds the cap even for a hugely oversized input', () => {
    const huge = 'abcdefghij'.repeat(5000); // 50k chars, well past the input ceiling
    const out = sanitizeBuildFailureReason(huge) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_BUILD_FAILURE_REASON_CHARS);
    expect(out.endsWith(BUILD_FAILURE_TRUNCATION_MARKER)).toBe(true);
  });

  it('the total stored deploy_detail stays under the 4000-char budget', () => {
    const detail = buildFailureDeployDetail('F'.repeat(500), 'y'.repeat(50_000));
    expect(detail.length).toBeLessThan(4000);
  });
});

describe('sanitizeBuildFailureReason — adversarial fixture', () => {
  // Everything a hostile author could plausibly put in their own build output.
  const adversarial = [
    `${ESC}]0;title-injection${BEL}`,
    `${ESC}[38;5;196mSCARY${ESC}[0m`,
    '</script><script>alert(1)</script>',
    '"; DROP TABLE app_blocks; --',
    'back\\slash and "quotes" and \'apostrophes\'',
    `nul>${NUL}<del>${DEL}<c1>${C1}<`,
    'carriage\rreturn\ttab',
    `${CSI8}2J`,
  ].join('\n');

  it('produces printable text + newlines ONLY', () => {
    const out = sanitizeBuildFailureReason(adversarial) as string;
    expect(out).toBeDefined();
    expect(disallowedChars(out)).toEqual([]);
  });

  it('removes every escape sequence and its payload', () => {
    const out = sanitizeBuildFailureReason(adversarial) as string;
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(CSI8);
    expect(out).not.toContain('title-injection');
    expect(out).not.toContain('[38;5;196m');
  });

  it('PRESERVES HTML-ish and SQL-ish text verbatim — escaping is the renderer\'s job', () => {
    // These are legitimate build-log characters. They are safe because the value is
    // only ever rendered through escaping React text nodes / JSON, never HTML.
    const out = sanitizeBuildFailureReason(adversarial) as string;
    expect(out).toContain('</script><script>alert(1)</script>');
    expect(out).toContain('DROP TABLE app_blocks');
    expect(out).toContain('back\\slash and "quotes"');
  });

  it('is idempotent — sanitizing twice changes nothing', () => {
    const once = sanitizeBuildFailureReason(adversarial) as string;
    expect(sanitizeBuildFailureReason(once)).toBe(once);
  });
});

describe('buildFailureDeployDetail — the DARK-SAFE contract', () => {
  it('with NO reason produces byte-identically what shipped before this feature', () => {
    // The pre-feature expression was: `Build ${String(status ?? 'failed').slice(0, 60)}`.
    expect(buildFailureDeployDetail('Failed', undefined)).toBe('Build Failed');
    expect(buildFailureDeployDetail('Cancelled', undefined)).toBe('Build Cancelled');
    expect(buildFailureDeployDetail(undefined, undefined)).toBe('Build failed');
  });

  it('a non-string reason is ignored — same string as no reason at all', () => {
    expect(buildFailureDeployDetail('Failed', 12345)).toBe('Build Failed');
    expect(buildFailureDeployDetail('Failed', { message: 'nope' })).toBe('Build Failed');
    expect(buildFailureDeployDetail('Failed', ['nope'])).toBe('Build Failed');
  });

  it('a reason that sanitizes to nothing is ignored — same string as no reason', () => {
    expect(buildFailureDeployDetail('Failed', '   \n\n  ')).toBe('Build Failed');
    expect(buildFailureDeployDetail('Failed', `${ESC}[0m`)).toBe('Build Failed');
  });

  it('appends a surviving excerpt after a blank line, keeping the Build prefix', () => {
    expect(buildFailureDeployDetail('Failed', 'ERROR: no package-lock.json is committed')).toBe(
      'Build Failed\n\nERROR: no package-lock.json is committed'
    );
  });

  it('keeps clamping the status prefix to 60 chars (unchanged behaviour)', () => {
    const detail = buildFailureDeployDetail('S'.repeat(200), 'why');
    expect(detail.startsWith(`Build ${'S'.repeat(60)}\n\n`)).toBe(true);
  });
});
