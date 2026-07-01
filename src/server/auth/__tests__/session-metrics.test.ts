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
}));

import { observeSessionLeg } from '../session-metrics';

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
    expect(h.histogram.observe).toHaveBeenCalledWith(
      { leg: 'identity', outcome: 'timeout' },
      1.5
    );
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
