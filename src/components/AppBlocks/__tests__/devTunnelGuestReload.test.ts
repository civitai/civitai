import { describe, expect, it } from 'vitest';

import { isDevTunnelGuestReload } from '../devTunnelGuestReload';

/**
 * The ONE predicate behind "the dev-tunnel app reloaded itself in the frame — ask for a
 * fresh entry URL". Pinned on literals rather than derived from the implementation.
 *
 * 🔴 The orderings the browser test cannot produce deterministically live here — above
 * all the frame's INITIAL `load` arriving AFTER BLOCK_READY (measured 2026-10-23 in
 * Chromium: READY at 24 ms, first `load` at 624 ms), which must not read as a reload or
 * the remount loops. Counts include the event being judged.
 */
describe('isDevTunnelGuestReload', () => {
  type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';
  type Surface = 'dev-tunnel' | 'page-run' | 'private-run' | 'review-preview';
  const load = (surface: Surface, loads: number, hellos: number, status: Status) =>
    isDevTunnelGuestReload({ surface, event: 'load', loads, hellos, status });
  const hello = (surface: Surface, loads: number, hellos: number, status: Status) =>
    isDevTunnelGuestReload({ surface, event: 'hello', loads, hellos, status });

  it('a load no hello accounts for, while ready → a reload (the refused 401)', () => {
    expect(load('dev-tunnel', 2, 1, 'ready')).toBe(true); // hello, load, READY, 401
    expect(load('dev-tunnel', 3, 2, 'ready')).toBe(true); // ...after a boot replace
    expect(load('dev-tunnel', 2, 0, 'ready')).toBe(true); // an SDK that never says hello
  });

  it('the initial load arriving AFTER ready is NOT a reload (the loop guard)', () => {
    expect(load('dev-tunnel', 1, 1, 'ready')).toBe(false);
    expect(load('dev-tunnel', 1, 0, 'ready')).toBe(false); // no hello: "at least two loads"
  });

  it('a document replaced during boot is NOT a reload: both documents said hello', () => {
    expect(load('dev-tunnel', 2, 2, 'ready')).toBe(false);
  });

  it('a hello while ready → a reload (a new document whose entry token was valid)', () => {
    expect(hello('dev-tunnel', 1, 2, 'ready')).toBe(true);
  });

  it('not ready → neither signal is a reload: the running handshake serves a new document', () => {
    for (const status of ['loading', 'timeout', 'fatal', 'no_token', 'error'] as const) {
      expect(load('dev-tunnel', 3, 0, status), status).toBe(false);
      expect(hello('dev-tunnel', 1, 2, status), status).toBe(false);
    }
  });

  it('every other surface → never, whatever the signal', () => {
    for (const surface of ['page-run', 'private-run', 'review-preview'] as const) {
      expect(load(surface, 2, 0, 'ready'), surface).toBe(false);
      expect(load(surface, 9, 1, 'ready'), surface).toBe(false);
      expect(hello(surface, 1, 2, 'ready'), surface).toBe(false);
    }
  });
});
