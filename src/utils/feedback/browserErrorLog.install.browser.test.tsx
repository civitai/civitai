import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installBrowserErrorLog,
  readConsoleErrors,
  readNetworkErrors,
  resetBrowserErrorLog,
} from '~/utils/feedback/browserErrorLog';

/**
 * `installBrowserErrorLog` — the half of the snapshot that `browserErrorLog.test.ts` structurally
 * CANNOT see.
 *
 * 🔴 WHY THIS FILE EXISTS AS A SEPARATE TIER. The unit project is `environment: 'node'`, so there
 * is no `window`, no `console` to patch and no `PerformanceObserver`; `installBrowserErrorLog`
 * early-returns there. Everything it does — the `console.error` wrapper, the two window listeners,
 * the resource observer — therefore had NO test at all, while the sanitizers next door had forty.
 * That is the isolation seam in its purest form: both halves green, the join unexercised.
 *
 * 🔴 AND THE OBVIOUS WAY TO WRITE THE DELEGATION TEST IS VACUOUS — recorded because the first
 * draft of this file did exactly it. `vi.spyOn(console, 'error')` REPLACES whatever is currently
 * on `console.error`, which after install is OUR WRAPPER. So the spy assertion passes by observing
 * the spy calling itself, with the wrapper uninstalled in all but name: it is green with the
 * delegation deleted, and green with the whole module deleted. The fix is ordering — put a
 * sentinel on `console.error` BEFORE installing, so the wrapper closes over the sentinel and
 * "did it delegate" becomes a real question. Every console test below installs inside the test
 * body for that reason; none of them uses `spyOn`.
 */
describe('installBrowserErrorLog', () => {
  /** Uninstallers to run no matter how a test exits, so a wrapper never leaks to the next one. */
  let cleanups: Array<() => void> = [];

  const withSentinelConsole = () => {
    const calls: unknown[][] = [];
    const realError = console.error;
    const sentinel = (...args: unknown[]) => {
      calls.push(args);
    };
    console.error = sentinel as typeof console.error;
    cleanups.push(() => {
      console.error = realError;
    });
    return { calls, sentinel };
  };

  const install = () => {
    const uninstall = installBrowserErrorLog();
    cleanups.push(uninstall);
    return uninstall;
  };

  beforeEach(() => {
    cleanups = [];
    resetBrowserErrorLog();
    // 🔴 THE RESOURCE-TIMING BUFFER IS PAGE-SCOPED AND OUTLIVES A TEST, and `observe({ buffered:
    // true })` REPLAYS it — which is the product behaviour we want (a recorder installed after
    // first paint still sees the page-load failures a reporter is filing about) and is test
    // poison: without this, the 404 raised by one test is replayed into the next test's observer
    // and read as a fresh capture. Found by running it: the "a successful request is not recorded"
    // control failed with two entries, neither of them from its own fetch.
    performance.clearResourceTimings();
  });

  afterEach(() => {
    // Reverse order: the console restore was pushed before the uninstall, and the uninstall has to
    // run while our wrapper is still the thing on `console.error`.
    for (const undo of [...cleanups].reverse()) undo();
    cleanups = [];
    resetBrowserErrorLog();
  });

  describe('console.error', () => {
    /**
     * 🔴 DELEGATION FIRST, AND IT IS THE PROPERTY THAT MAKES PATCHING A GLOBAL ACCEPTABLE AT ALL.
     * The wrapper must never swallow a log line — a developer's console, Next's dev overlay and
     * any forwarder all sit on the other side of this call.
     */
    test('calls through to the original, with the original arguments', () => {
      const { calls } = withSentinelConsole();
      install();

      console.error('delegated', 1);

      expect(calls).toEqual([['delegated', 1]]);
    });

    test('records the formatted arguments as well as delegating', () => {
      withSentinelConsole();
      install();

      console.error('boom', { a: 1 });

      expect(readConsoleErrors()).toContain('boom {"a":1}');
    });

    test('records an Error message and NOT its stack', () => {
      withSentinelConsole();
      install();

      console.error(new Error('render failed'));

      expect(readConsoleErrors()).toContain('Error: render failed');
      // A stack from this file would name it. Asserted on the joined buffer so a stack landing in
      // any entry fails, not only in the one this test happens to look at.
      expect(readConsoleErrors().join(' ')).not.toContain('browserErrorLog.install');
    });

    test('redacts on the way into the buffer, not on the way out', () => {
      withSentinelConsole();
      install();

      console.error('mail someone@example.com');

      expect(readConsoleErrors()).toContain('mail [redacted-email]');
    });

    /**
     * 🔴 THE UNINSTALL IS PART OF THE CONTRACT: a patch of a global that cannot be removed is one
     * an incident cannot undo. Both halves are asserted — the exact function is put back, and the
     * recording actually stops — because restoring a DIFFERENT function would satisfy the second
     * on its own.
     */
    test('uninstall puts the exact original back and stops recording', () => {
      const { calls, sentinel } = withSentinelConsole();
      const uninstall = install();

      console.error('while installed');
      expect(readConsoleErrors()).toContain('while installed');
      expect(console.error).not.toBe(sentinel);

      uninstall();

      expect(console.error).toBe(sentinel);
      resetBrowserErrorLog();
      console.error('after uninstall');
      // The sentinel still receives it — so the line is not lost, it is merely not recorded.
      expect(calls.at(-1)).toEqual(['after uninstall']);
      expect(readConsoleErrors()).toEqual([]);
    });

    /**
     * `_app.tsx` mounts this under React StrictMode, which runs mount → cleanup → mount in
     * development. A second install must not stack a second wrapper, or every line is recorded
     * twice and the 10-entry buffer holds five errors.
     */
    test('a second install is a no-op rather than a second wrapper', () => {
      withSentinelConsole();
      install();
      const second = installBrowserErrorLog();

      console.error('once');

      expect(readConsoleErrors().filter((line) => line === 'once')).toHaveLength(1);
      // The no-op uninstaller must also not tear down the live one.
      second();
      console.error('still recording');
      expect(readConsoleErrors()).toContain('still recording');
    });
  });

  describe('uncaught errors', () => {
    test('an error event is recorded', () => {
      install();

      window.dispatchEvent(
        new ErrorEvent('error', { message: 'Uncaught TypeError: x is not a function' })
      );

      expect(readConsoleErrors()).toContain('Uncaught TypeError: x is not a function');
    });

    /**
     * A resource load failure (`<img>`, `<script>`) also raises `error` on window, with an EMPTY
     * message and the element as the target. A blank line in front of a moderator is worse than
     * nothing; the resource observer is the instrument for those.
     *
     * ⚠️ AN INVARIANT GUARD, NOT REGRESSION COVERAGE, AND THE DISTINCTION IS EARNED. The blank
     * case is closed in TWO places — `onError`'s `if (event?.message)` and `recordConsoleError`'s
     * own `if (!message) return` — so deleting the first one leaves this green: the mutant dies to
     * the OTHER guard. Labelled rather than counted, and the `if` is kept as defence in depth for
     * a future caller that does not go through `recordConsoleError`.
     *
     * 🔴 IT ASSERTS `not.toContain('')`, NOT `toEqual([])`, AND THAT IS NOT A WEAKENING. Vitest's
     * browser runner reports a dispatched `error` event through `console.error(event)` — which our
     * own wrapper then records as `{"isTrusted":false}`. An `toEqual([])` here is therefore a
     * claim about the RUNNER, and it fails for a reason that has nothing to do with the guard.
     * (Measured: that is exactly how the first draft of this test failed.)
     */
    test('a message-less resource error event adds no blank line', () => {
      withSentinelConsole();
      install();

      window.dispatchEvent(new ErrorEvent('error', { message: '' }));

      expect(readConsoleErrors()).not.toContain('');
    });

    test('an unhandled rejection is recorded with its reason', async () => {
      install();

      // Dispatched rather than produced by a real floating promise: a genuinely unhandled
      // rejection in a test file is also an unhandled rejection for the RUNNER, which fails the
      // run for a reason that has nothing to do with this assertion.
      window.dispatchEvent(
        new PromiseRejectionEvent('unhandledrejection', {
          promise: Promise.resolve(),
          reason: new Error('the fetch blew up'),
        })
      );

      await vi.waitFor(() =>
        expect(readConsoleErrors()).toContain('Unhandled rejection: Error: the fetch blew up')
      );
    });
  });

  /**
   * 🔴 THE PASSIVE NETWORK CAPTURE, END TO END, AGAINST A REAL RESPONSE.
   *
   * `fetch` is deliberately NOT patched — see the mechanism note on the module — so the only thing
   * that can observe a failed request is a `PerformanceObserver` reading `responseStatus`. That
   * property is not universally implemented, and where it is absent this feature captures nothing
   * at all. This block therefore states its own scope: it asserts the capture works IN THIS
   * BROWSER (the `component` project's Chromium), and says so rather than generalising.
   */
  describe('failed requests, passively', () => {
    test('a real 404 is captured with its status, stripped of its query string', async () => {
      install();
      const url = `/__no_such_route__/${Date.now()}?token=LIVE-SECRET`;
      const response = await fetch(url).catch(() => null);

      // 🔴 INSTRUMENT CHECK. If the dev server ever answers this path with a 200, the observer has
      // nothing to see and the `waitFor` below would be waiting on an event that cannot happen —
      // a timeout that reads as "the recorder is broken". Assert the precondition instead.
      expect(response?.status, 'the test server answered a route that must not exist').toBe(404);

      await vi.waitFor(
        () => {
          const entry = readNetworkErrors().find((e) => e.url.includes('__no_such_route__'));
          expect(
            entry,
            'no resource-timing entry with a responseStatus — this browser may not implement it'
          ).toBeDefined();
          expect(entry?.status).toBe(404);
          // The whole point of `sanitizeNetworkUrl`, observed on a REAL entry rather than on a
          // string literal: the query string never reaches the buffer.
          expect(entry?.url).not.toContain('LIVE-SECRET');
          expect(entry?.url).not.toContain('?');
        },
        { timeout: 5000 }
      );
    });

    /**
     * The control for the test above. Without it, an implementation that recorded EVERY resource
     * would pass there while quietly storing a moderator-readable log of every URL the reporter's
     * browser touched — the exact over-collection this design exists to avoid.
     */
    test('a successful request is not recorded', async () => {
      install();
      // The page the runner is already serving — the one URL that is certainly a 200 here.
      // `/` is NOT: measured, the browser-mode server answers it with a 404, which is how the
      // first draft of this control passed for the wrong reason.
      const response = await fetch(window.location.href).catch(() => null);

      // Instrument check, the mirror of the one above: a `[]` below is only meaningful if the
      // request actually SUCCEEDED. A filter that drops EVERYTHING looks identical to one that
      // drops only successes, and this is the assertion that tells them apart.
      expect(response?.status, 'the control request did not succeed').toBe(200);

      // Long enough for the observer to have delivered: the 404 above lands well inside this.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(readNetworkErrors()).toEqual([]);
    });
  });
});
