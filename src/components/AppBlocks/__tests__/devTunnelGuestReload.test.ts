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
 * same — a loop. Hence: the SECOND load on the same frame element, while ready.
 */
describe('isDevTunnelGuestReload', () => {
  const at = (
    surface: 'dev-tunnel' | 'page-run' | 'private-run' | 'review-preview',
    loadsOnFrame: number,
    status: 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error'
  ) => isDevTunnelGuestReload({ surface, loadsOnFrame, status });

  it('dev-tunnel, ready, second load on the frame → a reload', () => {
    expect(at('dev-tunnel', 2, 'ready')).toBe(true);
    expect(at('dev-tunnel', 7, 'ready')).toBe(true);
  });

  it('the initial load arriving AFTER ready is NOT a reload (the loop guard)', () => {
    expect(at('dev-tunnel', 1, 'ready')).toBe(false);
  });

  it('not ready → not a reload: the running handshake still serves a new document', () => {
    for (const status of ['loading', 'timeout', 'fatal', 'no_token', 'error'] as const) {
      expect(at('dev-tunnel', 3, status), status).toBe(false);
    }
  });

  it('every other surface → never, whatever the count', () => {
    for (const surface of ['page-run', 'private-run', 'review-preview'] as const) {
      expect(at(surface, 2, 'ready'), surface).toBe(false);
      expect(at(surface, 9, 'ready'), surface).toBe(false);
    }
  });
});
