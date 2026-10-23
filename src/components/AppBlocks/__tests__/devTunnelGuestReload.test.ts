import { describe, expect, it } from 'vitest';

import { isDevTunnelGuestReload } from '../devTunnelGuestReload';

/**
 * The ONE predicate behind "the dev-tunnel app reloaded itself in the frame — ask for a
 * fresh entry URL". Pinned on literals rather than derived from the implementation.
 *
 * 🔴 The case the browser test cannot order deterministically lives here: the frame's
 * INITIAL `load` can arrive AFTER BLOCK_READY. The guest acks READY as soon as its module
 * code has the init, while `load` also waits for every image/stylesheet — measured
 * 2026-10-23 in Chromium: READY at 24 ms, first `load` at 624 ms. A "any load after
 * ready" predicate would remount on that first load, and the remounted frame would do the
 * same — a loop. Hence a load is a reload only when one was ALREADY seen since the last
 * BLOCK_HELLO (the count includes the load being judged).
 */
describe('isDevTunnelGuestReload', () => {
  type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';
  type Surface = 'dev-tunnel' | 'page-run' | 'private-run' | 'review-preview';
  const load = (surface: Surface, loadsSinceHello: number, status: Status) =>
    isDevTunnelGuestReload({ surface, event: 'load', loadsSinceHello, status });
  const hello = (surface: Surface, status: Status) =>
    isDevTunnelGuestReload({ surface, event: 'hello', loadsSinceHello: 0, status });

  it('dev-tunnel, ready, a second load since the last hello → a reload (the refused 401)', () => {
    expect(load('dev-tunnel', 2, 'ready')).toBe(true);
    expect(load('dev-tunnel', 7, 'ready')).toBe(true);
  });

  it('the first load since the hello, arriving AFTER ready, is NOT a reload (the loop guard)', () => {
    expect(load('dev-tunnel', 1, 'ready')).toBe(false);
  });

  it('dev-tunnel, ready, a hello → a reload (a new document whose entry token was valid)', () => {
    expect(hello('dev-tunnel', 'ready')).toBe(true);
  });

  it('not ready → neither signal is a reload: the running handshake serves a new document', () => {
    for (const status of ['loading', 'timeout', 'fatal', 'no_token', 'error'] as const) {
      expect(load('dev-tunnel', 3, status), status).toBe(false);
      expect(hello('dev-tunnel', status), status).toBe(false);
    }
  });

  it('every other surface → never, whatever the signal', () => {
    for (const surface of ['page-run', 'private-run', 'review-preview'] as const) {
      expect(load(surface, 2, 'ready'), surface).toBe(false);
      expect(load(surface, 9, 'ready'), surface).toBe(false);
      expect(hello(surface, 'ready'), surface).toBe(false);
    }
  });
});
