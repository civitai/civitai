import { beforeEach, describe, expect, it } from 'vitest';
import {
  FEEDBACK_CONSOLE_ERROR_MAX_COUNT,
  FEEDBACK_CONSOLE_ERROR_MAX_LENGTH,
  FEEDBACK_NETWORK_ERROR_MAX_COUNT,
  FEEDBACK_NETWORK_INITIATOR_MAX_LENGTH,
  FEEDBACK_NETWORK_URL_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';
import { redactText } from '~/utils/faro/redact';
import {
  formatConsoleArgs,
  readConsoleErrors,
  readNetworkErrors,
  recordConsoleError,
  recordNetworkError,
  resetBrowserErrorLog,
  sanitizeConsoleMessage,
  sanitizeNetworkUrl,
} from '~/utils/feedback/browserErrorLog';

/**
 * The capture side of the browser-error snapshot.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. It runs in the `unit` project (`environment: 'node'`), so
 * `installBrowserErrorLog` — the part that patches `console.error` and attaches a
 * `PerformanceObserver` — is out of reach here; it early-returns without a `window`. What IS under
 * test is everything that decides WHAT GETS STORED: the redaction, the bounds, the query-string
 * strip, the scheme refusal and the ring buffers. That is the whole of the privacy surface, and it
 * is deliberately all in pure functions for exactly that reason.
 */
describe('browser error log — sanitizing', () => {
  beforeEach(() => resetBrowserErrorLog());

  describe('the bounds themselves', () => {
    // Literals, so widening a bound reddens a test instead of being followed silently.
    it('is 10 / 300 / 10 / 300 / 20', () => {
      expect(FEEDBACK_CONSOLE_ERROR_MAX_COUNT).toBe(10);
      expect(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH).toBe(300);
      expect(FEEDBACK_NETWORK_ERROR_MAX_COUNT).toBe(10);
      expect(FEEDBACK_NETWORK_URL_MAX_LENGTH).toBe(300);
      expect(FEEDBACK_NETWORK_INITIATOR_MAX_LENGTH).toBe(20);
    });
  });

  describe('sanitizeConsoleMessage', () => {
    it('clips to the bound', () => {
      expect(sanitizeConsoleMessage('x'.repeat(500))).toHaveLength(300);
    });

    it('scrubs an email out of a message', () => {
      expect(sanitizeConsoleMessage('failed for someone@example.com')).toBe(
        'failed for [redacted-email]'
      );
    });

    it('scrubs a JWT out of a message', () => {
      const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM';
      expect(sanitizeConsoleMessage(`auth said ${jwt}`)).toBe('auth said [redacted-token]');
    });

    it('scrubs a sensitive query param out of a URL embedded in a message', () => {
      expect(
        sanitizeConsoleMessage('GET https://civitai.com/redeem-code?code=LIVE123 failed')
      ).toBe('GET https://civitai.com/redeem-code?code=REDACTED failed');
    });

    /**
     * 🔴 THE ORDER PROPERTY, AND IT IS THE REASON THIS FUNCTION EXISTS RATHER THAN AN INLINE
     * `.slice()`. Clipping BEFORE redacting cuts a secret in half, and half a JWT no longer
     * matches the pattern that would have removed it — so the stored value keeps the front of the
     * token, live, forever, in a column a moderator reads.
     *
     * 🔴 THE FIXTURE IS THE HARD PART AND THE FIRST ONE WAS VACUOUS — recorded here because it is
     * the failure this whole file is most exposed to. With a 290-character head, clipping first
     * leaves only NINE characters of the secret, which is too short to assert on and too short for
     * `not.toContain` to distinguish from a correct implementation: BOTH orders passed. The head
     * is now 250, so a clip-first implementation retains a 49-character live fragment.
     *
     * `CLIP_FIRST` below is the wrong order, computed rather than argued, and asserted to still
     * carry the fragment. That is the control: it proves this test CAN fail, and it is what makes
     * the two `expect`s on `out` a measurement rather than a hope.
     */
    it('redacts before it clips, so a secret straddling the boundary cannot survive in half', () => {
      const head = 'a'.repeat(250);
      const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u';
      const fragment = 'eyJhbGciOiJIUzI1NiJ9';
      const message = `${head} ${secret}`;

      // The fixture is the shape the test claims: the secret starts before the bound and ends
      // after it, so the two orders cannot agree.
      expect(message.indexOf(secret)).toBeLessThan(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
      expect(message.length).toBeGreaterThan(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);

      // 🔴 THE CONTROL. The wrong order, actually evaluated. If this ever stops carrying the
      // fragment the fixture has drifted back to vacuous and the assertions below prove nothing.
      const CLIP_FIRST = redactText(message.slice(0, FEEDBACK_CONSOLE_ERROR_MAX_LENGTH)).trim();
      expect(CLIP_FIRST).toContain(fragment);

      const out = sanitizeConsoleMessage(message);
      expect(out).toContain('[redacted-token]');
      expect(out).not.toContain(fragment);
      expect(out).not.toBe(CLIP_FIRST);
    });

    it('returns empty for a blank or non-string input, which callers treat as do-not-record', () => {
      expect(sanitizeConsoleMessage('   ')).toBe('');
      expect(sanitizeConsoleMessage(undefined as unknown as string)).toBe('');
    });
  });

  describe('sanitizeNetworkUrl', () => {
    it('strips the query string', () => {
      expect(sanitizeNetworkUrl('https://civitai.com/redeem-code?code=LIVE123')).toBe(
        'https://civitai.com/redeem-code'
      );
    });

    it('strips the fragment', () => {
      expect(sanitizeNetworkUrl('https://civitai.com/x#access_token=LIVE')).toBe(
        'https://civitai.com/x'
      );
    });

    it('strips a query string it does not recognise as sensitive', () => {
      // The rule is "no query string", not "no KNOWN-sensitive query string" — a param this
      // codebase has never heard of is exactly the one worth not storing.
      expect(sanitizeNetworkUrl('https://civitai.com/x?q=whatever&page=2')).toBe(
        'https://civitai.com/x'
      );
    });

    it('keeps the origin, so a third-party failure is still identifiable', () => {
      expect(sanitizeNetworkUrl('https://cdn.example.net/a/b.js')).toBe(
        'https://cdn.example.net/a/b.js'
      );
    });

    it('scrubs an email out of the surviving path', () => {
      expect(sanitizeNetworkUrl('https://civitai.com/user/someone@example.com')).toBe(
        'https://civitai.com/user/[redacted-email]'
      );
    });

    /**
     * 🔴 A `data:` URL IS ITS OWN PAYLOAD — there is no query string to remove, the whole value is
     * content, and it can be megabytes. `blob:` is the same shape and is already the spelling the
     * moderator's `IMAGE_KEY` guard treats as hostile.
     */
    it('refuses a non-http(s) scheme outright', () => {
      expect(sanitizeNetworkUrl('data:text/plain;base64,SGVsbG8=')).toBeNull();
      expect(sanitizeNetworkUrl('blob:https://civitai.com/abcd')).toBeNull();
      expect(sanitizeNetworkUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeNetworkUrl('file:///etc/passwd')).toBeNull();
    });

    it('returns null for something it cannot parse, rather than storing it unstripped', () => {
      expect(sanitizeNetworkUrl('/relative/with?query=1')).toBeNull();
      expect(sanitizeNetworkUrl('')).toBeNull();
    });

    it('resolves against a base when one is given', () => {
      expect(sanitizeNetworkUrl('/api/trpc/x?token=LIVE', 'https://civitai.com/page')).toBe(
        'https://civitai.com/api/trpc/x'
      );
    });

    it('clips to the URL bound', () => {
      const long = `https://civitai.com/${'a'.repeat(400)}`;
      expect(sanitizeNetworkUrl(long)).toHaveLength(300);
    });
  });

  describe('formatConsoleArgs', () => {
    it('joins strings as the console shows them', () => {
      expect(formatConsoleArgs(['a', 'b'])).toBe('a b');
    });

    /** The message, never the stack — see the "deliberately not captured" list on the module. */
    it('takes an Error name and message and NOT its stack', () => {
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at SECRETFRAME (https://civitai.com/_next/x.js:1:1)';
      const out = formatConsoleArgs([error]);
      expect(out).toBe('Error: boom');
      expect(out).not.toContain('SECRETFRAME');
    });

    it('serialises a plain object', () => {
      expect(formatConsoleArgs([{ a: 1 }])).toBe('{"a":1}');
    });

    it('survives a circular structure without throwing', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => formatConsoleArgs([circular])).not.toThrow();
      expect(formatConsoleArgs([circular])).toBe('[object Object]');
    });

    it('survives a throwing toString without throwing', () => {
      const hostile = {
        toString() {
          throw new Error('nope');
        },
      };
      // `JSON.stringify` succeeds on this one, which is the point — it must not reach `String()`.
      expect(() => formatConsoleArgs([hostile])).not.toThrow();
    });

    it('survives a value that is neither stringifiable nor String()-able', () => {
      const hostile = {
        toJSON() {
          throw new Error('nope');
        },
        toString() {
          throw new Error('nope either');
        },
      };
      expect(formatConsoleArgs([hostile])).toBe('[unserializable]');
    });
  });
});

describe('browser error log — buffers', () => {
  beforeEach(() => resetBrowserErrorLog());

  it('keeps the LAST N console errors, not the first N', () => {
    for (let i = 0; i < 25; i++) recordConsoleError(`error ${i}`);
    const out = readConsoleErrors();
    expect(out).toHaveLength(10);
    // The last ones. A first-N buffer would end at `error 9`.
    expect(out[0]).toBe('error 15');
    expect(out[9]).toBe('error 24');
  });

  it('keeps the LAST N network errors, not the first N', () => {
    for (let i = 0; i < 25; i++)
      recordNetworkError({ url: `https://civitai.com/${i}`, status: 500, initiatorType: 'fetch' });
    const out = readNetworkErrors();
    expect(out).toHaveLength(10);
    expect(out[0].url).toBe('https://civitai.com/15');
    expect(out[9].url).toBe('https://civitai.com/24');
  });

  it('stores console errors already sanitized, so a reader cannot forget to', () => {
    recordConsoleError('mail someone@example.com');
    expect(readConsoleErrors()).toEqual(['mail [redacted-email]']);
  });

  it('stores network URLs already stripped, so a reader cannot forget to', () => {
    recordNetworkError({
      url: 'https://civitai.com/redeem-code?code=LIVE123',
      status: 500,
      initiatorType: 'fetch',
    });
    expect(readNetworkErrors()).toEqual([
      { url: 'https://civitai.com/redeem-code', status: 500, initiatorType: 'fetch' },
    ]);
  });

  it('drops a blank console message rather than storing an empty entry', () => {
    recordConsoleError('   ');
    expect(readConsoleErrors()).toEqual([]);
  });

  /**
   * 🔴 THE PRODUCER-SIDE HALF OF THE SCHEMA'S `400..599` BOUND. The schema REJECTS a status
   * outside it, and a rejection fails the reporter's whole submission — so a recorder that let a
   * 200 into the buffer would turn one stray entry into a submit failure on the surface that
   * exists to collect reports. One rule, enforced at both ends.
   */
  it('records only 4xx and 5xx', () => {
    for (const status of [0, 100, 200, 301, 399, 600, 999])
      recordNetworkError({ url: 'https://civitai.com/x', status, initiatorType: 'fetch' });
    expect(readNetworkErrors()).toEqual([]);

    recordNetworkError({ url: 'https://civitai.com/a', status: 400, initiatorType: 'fetch' });
    recordNetworkError({ url: 'https://civitai.com/b', status: 599, initiatorType: 'fetch' });
    expect(readNetworkErrors().map((e) => e.status)).toEqual([400, 599]);
  });

  /**
   * 🔴 THE `undefined` CASE IS THE REAL ONE AND IT IS NOT HYPOTHETICAL. The observer reads
   * `PerformanceResourceTiming.responseStatus`, which the DOM lib types as `number` but which is
   * UNIMPLEMENTED in some browsers — so this function receives `undefined` for every resource on
   * such a browser, with TypeScript raising nothing. This is the only guard standing between that
   * and a buffer full of `{status: undefined}`; the observer carries no second check, on purpose
   * (a duplicate there could not be killed by any mutant — it died to this one).
   *
   * `undefined` is cast in rather than declared optional because the CALLER's type really is
   * `number`; the lie is in the DOM lib, and a test that changed the signature to match the lie
   * would stop reproducing the situation.
   */
  it('records nothing for a non-integer or absent status', () => {
    recordNetworkError({ url: 'https://civitai.com/x', status: 404.5, initiatorType: 'fetch' });
    recordNetworkError({ url: 'https://civitai.com/x', status: NaN, initiatorType: 'fetch' });
    recordNetworkError({
      url: 'https://civitai.com/x',
      status: undefined as unknown as number,
      initiatorType: 'fetch',
    });
    expect(readNetworkErrors()).toEqual([]);
  });

  it('records nothing when the URL cannot be stripped', () => {
    recordNetworkError({ url: 'data:text/plain,hello', status: 404, initiatorType: 'other' });
    expect(readNetworkErrors()).toEqual([]);
  });

  it('defaults and clips initiatorType rather than rejecting the entry', () => {
    recordNetworkError({ url: 'https://civitai.com/a', status: 404 });
    recordNetworkError({
      url: 'https://civitai.com/b',
      status: 404,
      initiatorType: 'x'.repeat(50),
    });
    expect(readNetworkErrors().map((e) => e.initiatorType)).toEqual(['other', 'x'.repeat(20)]);
  });

  it('hands back a copy, so a caller mutating the result cannot corrupt the buffer', () => {
    recordConsoleError('boom');
    readConsoleErrors().push('injected');
    expect(readConsoleErrors()).toEqual(['boom']);
  });

  it('reads empty before anything is recorded, which is the ordinary case', () => {
    expect(readConsoleErrors()).toEqual([]);
    expect(readNetworkErrors()).toEqual([]);
  });
});
