import { describe, expect, it } from 'vitest';

import { shouldStartInit } from '../iframeInitController';

/**
 * Coverage for the init-START gate — the predicate the host effect keys on.
 *
 * THIS is the regression unit for the prod blank-iframe bug. The old host
 * required `iframeLoaded === true` before it would post BLOCK_INIT or arm the
 * readiness timeout. On prod the cached block bundle's `load` event fired
 * before React attached `onLoad`, so `iframeLoaded` never flipped and init was
 * never attempted — a silent indefinite skeleton. The new gate has NO load
 * input: with a token and a resolved checkpoint we start initing regardless of
 * whether the iframe `load` event was ever observed.
 *
 * It also pins the gating that MUST still hold (so we don't over-correct):
 * still wait for the token, still wait for the checkpoint query, and never
 * (re)start once we've left the loading state.
 */
describe('shouldStartInit', () => {
  describe('the race regression: starts WITHOUT any iframe-load signal', () => {
    it('starts when token present + checkpoint resolved (no load concept at all)', () => {
      // There is intentionally no `iframeLoaded` parameter — load-independence
      // is structural. The old code could not have returned true here without
      // a load event having fired first.
      expect(shouldStartInit({ status: 'loading', hasToken: true, checkpointLoading: false })).toBe(
        true
      );
    });
  });

  describe('preserves the gating that SHOULD hold before init', () => {
    it('does NOT start while the token is missing (token-wait path owns this)', () => {
      expect(
        shouldStartInit({ status: 'loading', hasToken: false, checkpointLoading: false })
      ).toBe(false);
    });

    it('does NOT start while the effective-checkpoint query is still loading', () => {
      expect(shouldStartInit({ status: 'loading', hasToken: true, checkpointLoading: true })).toBe(
        false
      );
    });
  });

  describe('never (re)starts once out of the loading state', () => {
    it.each(['ready', 'timeout', 'fatal', 'no_token'] as const)(
      'returns false for terminal/ready status "%s" even with a token + resolved checkpoint',
      (status) => {
        expect(shouldStartInit({ status, hasToken: true, checkpointLoading: false })).toBe(false);
      }
    );
  });
});
