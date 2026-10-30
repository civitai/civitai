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

    /**
     * 🔴 THE MARKER IS THE ONLY THING SEPARATING "CUT OFF HERE" FROM "THIS IS THE WHOLE MESSAGE".
     * A React hydration error runs well past 300 characters and a real 300-character message does
     * not, and the moderator panel draws both as the same bordered box — so without the marker a
     * moderator reads a fragment as a complete error and looks for a component name that was cut.
     *
     * 🔴 BOTH ARMS, AND THE BOUNDARY FROM BOTH SIDES. An unconditional marker is the obvious wrong
     * implementation and it passes a cut-only test: it would stamp "there is more" onto every
     * complete message. `300` must be unmarked and `301` must be marked — one character apart, so
     * a `>=`/`>` slip in `clip` is visible here rather than only in production.
     */
    it('marks a clipped message, and only when it actually cut', () => {
      const cut = sanitizeConsoleMessage('x'.repeat(500));
      expect(cut.endsWith('…')).toBe(true);
      // The marker is SPENT out of the bound, never added to it: the schema REJECTS an over-long
      // value, so a 301-character result would fail the reporter's whole submission.
      expect(cut).toHaveLength(300);
      expect(cut).toBe(`${'x'.repeat(299)}…`);

      // Exactly at the bound: complete, so no marker and no character spent saying so.
      const exact = sanitizeConsoleMessage('y'.repeat(300));
      expect(exact).toBe('y'.repeat(300));
      expect(exact).not.toContain('…');

      // One over: marked. The pair either side of the boundary is the point.
      expect(sanitizeConsoleMessage('z'.repeat(301))).toBe(`${'z'.repeat(299)}…`);

      // Well under: untouched.
      expect(sanitizeConsoleMessage('short')).toBe('short');
    });

    /**
     * 🔴 A CLIP THAT CUTS AN EMOJI IN HALF LOSES THE REPORTER'S WHOLE SUBMISSION, NOT A CHARACTER.
     * `length` and `slice` count UTF-16 code units, so a boundary landing between the two halves of
     * an astral character leaves a LONE SURROGATE. That value is still 300 units long, so the
     * schema's `.max(300)` passes it; `JSON.stringify` preserves it as an unpaired `\uD83D` escape
     * across the wire; and `Feedback.context` is a `jsonb` column, where Postgres rejects it with
     * `invalid input syntax for type json` — measured against a real engine, with the same string's
     * pair-intact twin inserting cleanly as the control. The report is then lost with an error that
     * names nothing about the snapshot.
     *
     * 🔴 THE FIXTURE IS THE HARD PART, AS IT WAS FOR THE REDACT-BEFORE-CLIP TEST ABOVE. An emoji
     * anywhere else in the string is clipped away whole and proves nothing; the pair has to
     * STRADDLE the cut. `NAIVE` below is the old implementation's output, computed rather than
     * argued, and asserted to be ill-formed — that is the control proving this test CAN fail.
     */
    it('does not cut a surrogate pair in half when it clips', () => {
      // 298 + the pair's first unit is exactly the 299 units the old `clip` kept before the marker.
      const message = `${'a'.repeat(298)}😀${'b'.repeat(50)}`;

      // 🔴 THE CONTROL. The old behaviour, actually evaluated.
      const NAIVE = `${message.slice(0, FEEDBACK_CONSOLE_ERROR_MAX_LENGTH - 1)}…`;
      expect(NAIVE).toHaveLength(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
      expect(NAIVE.isWellFormed()).toBe(false);

      const out = sanitizeConsoleMessage(message);
      expect(out.isWellFormed()).toBe(true);
      // The whole character goes, rather than half of it staying: 298 `a`s and the marker, one
      // short of the bound. Shorter than `max` is fine; longer is what the schema rejects.
      expect(out).toBe(`${'a'.repeat(298)}…`);
      expect(out.length).toBeLessThanOrEqual(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
    });

    /**
     * The other side of the same boundary, and it is what stops the fix from over-trimming. Here
     * the pair ends exactly ON the cut, so it is entirely inside the kept region and must survive
     * intact — a guard that dropped the last character whenever it saw a surrogate would shorten
     * every clipped message containing one and would pass the test above.
     */
    it('keeps an astral character that ends exactly on the boundary', () => {
      const message = `${'a'.repeat(297)}😀${'b'.repeat(50)}`;

      const out = sanitizeConsoleMessage(message);
      expect(out).toBe(`${'a'.repeat(297)}😀…`);
      expect(out).toHaveLength(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
      expect(out.isWellFormed()).toBe(true);
    });

    /**
     * The half `clip` never covered: a lone surrogate the caller HANDED us. `clip` only guards the
     * cut it makes itself, so a short message never reaches it at all — and the consequence is the
     * one `clip`'s docblock measures, a rejected `jsonb` insert that loses the whole submission.
     */
    it('drops an input-borne lone surrogate that never reaches the clip boundary', () => {
      const message = `\ud800${'x'.repeat(10)}`;

      // 🔴 THE CONTROL: this input is short enough that clipping does nothing, so the old code
      // returned it untouched and not well-formed.
      expect(message.length).toBeLessThan(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
      expect(message.isWellFormed()).toBe(false);

      const out = sanitizeConsoleMessage(message);
      expect(out.isWellFormed()).toBe(true);
      expect(out).toBe('x'.repeat(10));
    });

    it('drops an input-borne lone surrogate sitting away from the cut in a clipped message', () => {
      const message = `\ud800${'a'.repeat(400)}`;

      const out = sanitizeConsoleMessage(message);
      expect(out.isWellFormed()).toBe(true);
      expect(out.length).toBeLessThanOrEqual(FEEDBACK_CONSOLE_ERROR_MAX_LENGTH);
    });

    /**
     * The over-drop control for the pass above — a well-formed astral character must survive it
     * untouched, or the guard would quietly strip every emoji a reporter's console contains.
     */
    it('keeps a well-formed astral character that needs no clipping', () => {
      expect(sanitizeConsoleMessage('ok 😀 done')).toBe('ok 😀 done');
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

    /**
     * The same marker, for the same reason as `sanitizeConsoleMessage`: a clipped URL and a long
     * complete one render identically in the panel, and a moderator comparing a clipped path
     * against the route they think failed needs to know the tail is missing.
     *
     * Both arms and the boundary from both sides, as above — an unconditional marker would pass a
     * cut-only assertion while stamping every long-but-complete URL.
     */
    it('marks a clipped URL, and only when it actually cut', () => {
      const cut = sanitizeNetworkUrl(`https://civitai.com/${'a'.repeat(400)}`);
      expect(cut?.endsWith('…')).toBe(true);
      expect(cut).toHaveLength(300);

      // `https://civitai.com/` is 20 characters, so a 280-character path lands exactly on 300.
      const exact = `https://civitai.com/${'b'.repeat(280)}`;
      expect(exact).toHaveLength(300);
      expect(sanitizeNetworkUrl(exact)).toBe(exact);

      // One character more: marked, and still exactly 300 long.
      const over = `https://civitai.com/${'c'.repeat(281)}`;
      expect(sanitizeNetworkUrl(over)).toBe(`${over.slice(0, 299)}…`);

      // Well under: untouched, so an ordinary URL never grows a marker.
      expect(sanitizeNetworkUrl('https://civitai.com/x')).toBe('https://civitai.com/x');
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

  it('keeps the LAST N DISTINCT console errors, not the first N', () => {
    for (let i = 0; i < 25; i++) recordConsoleError(`error ${i}`);
    const out = readConsoleErrors();
    expect(out).toHaveLength(10);
    // The last ones. A first-N buffer would end at `error 9`.
    expect(out[0]).toEqual({ message: 'error 15', count: 1 });
    expect(out[9]).toEqual({ message: 'error 24', count: 1 });
  });

  /**
   * 🔴 THE DEFECT THIS FIXES, REPRODUCED. One broken React render is not one `console.error` — the
   * error, the component stack, the boundary re-render and the retry all arrive as separate calls,
   * and a keep-the-last-ten buffer ships ten copies of the downstream symptom with the ORIGINATING
   * error already evicted. That is the entry a moderator needs and the one that used to go missing.
   *
   * The fixture is a cascade, not a clean sequence: the originating error arrives FIRST and is then
   * buried under far more repeats than the bound. The assertion is that it survived.
   */
  it('keeps the originating error when a cascade repeats one message past the bound', () => {
    recordConsoleError('TypeError: cannot read properties of undefined (reading "id")');
    for (let i = 0; i < 40; i++) recordConsoleError('The above error occurred in <ModelCard>');

    const out = readConsoleErrors();
    // Two DISTINCT messages from 41 events, and the first one is still here. Before the collapse
    // this read as ten copies of the second message and nothing else.
    expect(out).toEqual([
      { message: 'TypeError: cannot read properties of undefined (reading "id")', count: 1 },
      { message: 'The above error occurred in <ModelCard>', count: 40 },
    ]);
  });

  it('collapses a repeat into a count rather than spending a slot on it', () => {
    recordConsoleError('boom');
    recordConsoleError('boom');
    recordConsoleError('boom');
    expect(readConsoleErrors()).toEqual([{ message: 'boom', count: 3 }]);
  });

  /**
   * 🔴 A REPEAT MUST NOT REFRESH RECENCY, AND THIS IS THE ARM THAT CATCHES IT. Bumping a repeated
   * entry to the end of the buffer is the natural-looking implementation (it is what an LRU does),
   * and it REINTRODUCES the original defect by a different route: a message firing in a loop would
   * outlive, and then evict, the originating error that arrived before it.
   *
   * The fixture makes the two orderings disagree — `first` is repeated AFTER `second` is seen, so a
   * recency-refreshing buffer would order them `second, first`.
   */
  it('does not move a repeated entry to the end', () => {
    recordConsoleError('first');
    recordConsoleError('second');
    recordConsoleError('first');

    expect(readConsoleErrors().map((e) => e.message)).toEqual(['first', 'second']);
    expect(readConsoleErrors()).toEqual([
      { message: 'first', count: 2 },
      { message: 'second', count: 1 },
    ]);
  });

  /**
   * The bound is on DISTINCT messages, so a repeat of something already held must NOT evict
   * anything — that is the whole reason the collapse buys room for genuinely distinct errors.
   */
  it('a repeat of a held message evicts nothing', () => {
    for (let i = 0; i < 10; i++) recordConsoleError(`error ${i}`);
    for (let i = 0; i < 50; i++) recordConsoleError('error 0');

    const out = readConsoleErrors();
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ message: 'error 0', count: 51 });
    // `error 9` is still the last entry: nothing was pushed out by 50 repeats.
    expect(out[9]).toEqual({ message: 'error 9', count: 1 });
  });

  /**
   * An evicted message must lose its count with it. If eviction dropped the entry but left the
   * `message → entry` index pointing at it, the same message arriving again would increment an
   * object no longer in the buffer — a console error recorded after eviction would then be stored
   * NOWHERE, silently, and only on the second sighting.
   */
  it('re-admits an evicted message as a fresh entry rather than losing it', () => {
    recordConsoleError('evict-me');
    for (let i = 0; i < 10; i++) recordConsoleError(`filler ${i}`);
    expect(readConsoleErrors().map((e) => e.message)).not.toContain('evict-me');

    recordConsoleError('evict-me');
    recordConsoleError('evict-me');
    const out = readConsoleErrors();
    expect(out).toHaveLength(10);
    expect(out[9]).toEqual({ message: 'evict-me', count: 2 });
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
    expect(readConsoleErrors()).toEqual([{ message: 'mail [redacted-email]', count: 1 }]);
  });

  /**
   * Repeats are keyed on the SANITIZED message, which is what makes the collapse work on the case
   * it exists for: two failures differing only inside a redacted span are the same error to a
   * moderator, and a raw-keyed buffer would spend two slots on them.
   */
  it('collapses messages that differ only in redacted content', () => {
    recordConsoleError('login failed for alice@example.com');
    recordConsoleError('login failed for bob@example.com');
    expect(readConsoleErrors()).toEqual([
      { message: 'login failed for [redacted-email]', count: 2 },
    ]);
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
   * 🔴 THE REPEAT INDEX IS KEYED BY UNTRUSTED TEXT, so it must be a `Map` and not a plain object.
   * With `{}` the lookup `index[message]` for a message of `'__proto__'`, `'constructor'` or
   * `'toString'` returns an inherited value that is TRUTHY — so the recorder would take the
   * "already seen" branch, do `count += 1` on something that is not an entry, and the message would
   * be stored NOWHERE while the first sighting silently vanished. Prototype keys are not exotic
   * here: `console.error(someObj)` formats to JSON, and React and library errors mention these
   * names routinely.
   *
   * Pins the data structure by BEHAVIOUR rather than by grepping for the word `Map`.
   */
  it('records a message that collides with an Object prototype key', () => {
    for (const hostile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      recordConsoleError(hostile);
    }
    expect(readConsoleErrors()).toEqual([
      { message: '__proto__', count: 1 },
      { message: 'constructor', count: 1 },
      { message: 'toString', count: 1 },
      { message: 'hasOwnProperty', count: 1 },
    ]);

    // And they still collapse like any other message, rather than taking a different branch.
    recordConsoleError('__proto__');
    expect(readConsoleErrors()[0]).toEqual({ message: '__proto__', count: 2 });
  });

  /**
   * The schema bounds `count` at `>= 1`, so a stored entry must never claim zero occurrences. This
   * is the producer half: an entry exists only because it was recorded at least once.
   */
  it('never stores an entry with a count below 1', () => {
    for (let i = 0; i < 15; i++) recordConsoleError(`error ${i}`);
    recordConsoleError('error 14');
    for (const entry of readConsoleErrors()) expect(entry.count).toBeGreaterThanOrEqual(1);
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
    readConsoleErrors().push({ message: 'injected', count: 99 });
    expect(readConsoleErrors()).toEqual([{ message: 'boom', count: 1 }]);
  });

  /**
   * 🔴 THE ENTRIES MUST BE COPIES TOO, NOT JUST THE ARRAY, BECAUSE `count` IS MUTABLE AND THE
   * BUFFER KEEPS RECORDING AFTER A READ. `useFeedbackSubmission` reads the array and then awaits
   * image uploads before the mutation fires, so a shared reference would let an error arriving in
   * that window change a count in the payload already assembled — and, in the other direction, a
   * caller mutating what it was handed would corrupt the buffer. A `[...this.entries]` shallow copy
   * of the array passes the test above and fails this one.
   */
  it('hands back copies of the entries, not the live objects', () => {
    recordConsoleError('boom');
    const snapshot = readConsoleErrors();

    // The buffer moves on after the read.
    recordConsoleError('boom');
    expect(snapshot[0].count).toBe(1);
    expect(readConsoleErrors()[0].count).toBe(2);

    // And a caller writing to what it was handed cannot reach the buffer.
    snapshot[0].count = 999;
    snapshot[0].message = 'tampered';
    expect(readConsoleErrors()).toEqual([{ message: 'boom', count: 2 }]);
  });

  it('reads empty before anything is recorded, which is the ordinary case', () => {
    expect(readConsoleErrors()).toEqual([]);
    expect(readNetworkErrors()).toEqual([]);
  });
});
