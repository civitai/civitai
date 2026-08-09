import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stable metric spies so we can assert the histogram + counter wiring. A file-level vi.mock overrides the
// global prom/client stub (src/__tests__/setup.ts) for this module.
const h = vi.hoisted(() => ({
  histogram: { observe: vi.fn() },
  counter: { inc: vi.fn() },
}));

vi.mock('~/server/prom/client', () => ({
  registerHistogram: vi.fn(() => h.histogram),
  registerCounterWithLabels: vi.fn(() => h.counter),
  registerCounter: vi.fn(() => h.counter),
}));

import {
  observeSessionLeg,
  observeLegacyDecode,
  observeLegacyUpgrade,
  observeSessionStateUpdate,
} from '../session-metrics';

beforeEach(() => {
  h.histogram.observe.mockClear();
  h.counter.inc.mockClear();
});

describe('observeSessionLeg — civitai_app_session_resolution_* wiring', () => {
  it('observes the duration histogram on every outcome (labeled leg + outcome)', () => {
    observeSessionLeg('identity', 'hit', 0.02);
    expect(h.histogram.observe).toHaveBeenCalledWith({ leg: 'identity', outcome: 'hit' }, 0.02);
    expect(h.counter.inc).not.toHaveBeenCalled(); // a hit is not a timeout
  });

  // The coordinator-required assertion: the timeout PATH increments session_resolution_timeouts_total.
  it('increments the timeouts counter ONLY on a timeout outcome (labeled by leg)', () => {
    observeSessionLeg('identity', 'timeout', 1.5);
    expect(h.histogram.observe).toHaveBeenCalledWith({ leg: 'identity', outcome: 'timeout' }, 1.5);
    expect(h.counter.inc).toHaveBeenCalledWith({ leg: 'identity' });
    expect(h.counter.inc).toHaveBeenCalledTimes(1);
  });

  it('increments the timeouts counter per leg (all five legs)', () => {
    observeSessionLeg('jwks', 'timeout', 2.5);
    observeSessionLeg('revocation', 'timeout', 2.0);
    observeSessionLeg('identity-by-id', 'timeout', 1.5);
    observeSessionLeg('hub-write', 'timeout', 1.5);
    expect(h.counter.inc).toHaveBeenCalledWith({ leg: 'jwks' });
    expect(h.counter.inc).toHaveBeenCalledWith({ leg: 'revocation' });
    expect(h.counter.inc).toHaveBeenCalledWith({ leg: 'identity-by-id' });
    expect(h.counter.inc).toHaveBeenCalledWith({ leg: 'hub-write' });
    expect(h.counter.inc).toHaveBeenCalledTimes(4);
  });

  it('does NOT increment the counter on error / miss outcomes (only real timeouts)', () => {
    observeSessionLeg('identity', 'error', 0.5);
    observeSessionLeg('revocation', 'error', 0.1);
    observeSessionLeg('identity', 'miss', 0.03);
    expect(h.counter.inc).not.toHaveBeenCalled();
    expect(h.histogram.observe).toHaveBeenCalledTimes(3);
  });
});

// The store keeps only LAST-TOUCH data per tracked token (trackToken writes the value and re-arms the field
// TTL on every call, including the rolling refresh), so no redis query can recover a session MINT rate for
// any account. These two instruments are the only ones that can see it.
describe('observeLegacyUpgrade — the only mint-rate instrument', () => {
  it('counts each outcome under a bounded label (never per-user)', () => {
    observeLegacyUpgrade('minted');
    observeLegacyUpgrade('failed');
    expect(h.counter.inc).toHaveBeenCalledWith({ outcome: 'minted' });
    expect(h.counter.inc).toHaveBeenCalledWith({ outcome: 'failed' });
    expect(h.counter.inc).toHaveBeenCalledTimes(2);
  });
});

describe('observeSessionStateUpdate — caller attribution + size', () => {
  // Duration rather than a bare count because redis SLOWLOG cannot see this: at the ~6-8k token counts that
  // persist, hGetAll costs ~6-10ms, just under the 10ms slowlog threshold.
  it('records BOTH the duration and the token count against the same caller/type labels', () => {
    observeSessionStateUpdate('ban', 'invalid', 4200, 0.031);
    expect(h.histogram.observe).toHaveBeenCalledWith({ caller: 'ban', type: 'invalid' }, 0.031);
    expect(h.histogram.observe).toHaveBeenCalledWith({ caller: 'ban', type: 'invalid' }, 4200);
    expect(h.histogram.observe).toHaveBeenCalledTimes(2);
  });

  it('distinguishes callers, so a hot path is attributable rather than aggregate', () => {
    observeSessionStateUpdate('browsing-mode', 'refresh', 3, 0.002);
    observeSessionStateUpdate('subscription', 'refresh', 3, 0.002);
    expect(h.histogram.observe).toHaveBeenCalledWith(
      { caller: 'browsing-mode', type: 'refresh' },
      3
    );
    expect(h.histogram.observe).toHaveBeenCalledWith(
      { caller: 'subscription', type: 'refresh' },
      3
    );
  });
});

// 🔴 The legacy-decode counter must be UNLABELLED. A labelled counter registers each child lazily at the
// first .inc(), so an empty result cannot be told apart from "not deployed" or "module never imported" —
// which is exactly the ambiguity it exists to resolve. Unlabelled, it emits an observable 0 from module
// load, so `0` means the path is genuinely dead and an ABSENT series means the instrument is broken.
describe('observeLegacyDecode — zero must be observable, not absent', () => {
  it('registers through the UNLABELLED counter helper, not the labelled one', async () => {
    const prom = await import('~/server/prom/client');
    const unlabelled = vi.mocked(prom.registerCounter).mock.calls.map(([cfg]) => cfg.name);
    const labelled = vi.mocked(prom.registerCounterWithLabels).mock.calls.map(([cfg]) => cfg.name);

    expect(unlabelled).toContain('session_legacy_decode_total');
    expect(labelled).not.toContain('session_legacy_decode_total');
  });

  it('increments without any label, so there is exactly one series', () => {
    observeLegacyDecode();
    expect(h.counter.inc).toHaveBeenCalledWith();
  });
});
