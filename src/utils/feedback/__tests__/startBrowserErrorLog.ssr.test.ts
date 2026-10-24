import { describe, expect, it } from 'vitest';

/**
 * The SSR half of the install-timing fix.
 *
 * 🔴 `_app.tsx` IS EVALUATED ON THE SERVER TOO, so moving the install from a `useEffect` to module
 * scope moved it onto a code path that has no `window`. `installBrowserErrorLog` already guards on
 * `typeof window === 'undefined'` — this pins that the guard is what makes the MODULE-SCOPE call
 * safe, from the side that would otherwise only be discovered by a production 500.
 *
 * 🔴 THE IMPORT IS DYNAMIC, DELIBERATELY. A static import would still catch a removed guard — the
 * file would throw `ReferenceError: window is not defined` while loading — but it would do it
 * during COLLECTION, reported as a file that failed to load rather than as this test failing. A
 * dynamic import inside the body puts the failure on this assertion, where it says what it means.
 */
describe('startBrowserErrorLog under SSR', () => {
  it('imports cleanly and records nothing when there is no window', async () => {
    // Instrument check: this project is `environment: 'node'`. If a future config change gives it
    // a `window`, the assertions below would pass while testing the browser case by accident.
    expect(typeof window).toBe('undefined');

    await expect(import('~/utils/feedback/startBrowserErrorLog')).resolves.toBeDefined();

    const { readConsoleErrors, readNetworkErrors } = await import(
      '~/utils/feedback/browserErrorLog'
    );
    expect(readConsoleErrors()).toEqual([]);
    expect(readNetworkErrors()).toEqual([]);
  });
});
