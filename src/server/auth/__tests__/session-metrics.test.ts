import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  histogram: { observe: vi.fn() },
  counter: { inc: vi.fn() },
}));

vi.mock('~/server/prom/client', () => ({
  registerHistogram: vi.fn(() => h.histogram),
  registerCounterWithLabels: vi.fn(() => h.counter),
}));

import { observeSessionLeg } from '../session-metrics';

describe('observeSessionLeg', () => {
  it('increments the timeouts counter ONLY on a timeout outcome (labeled by leg)', () => {
    h.counter.inc.mockClear();
    observeSessionLeg('identity', 'timeout', 1.5);
    observeSessionLeg('identity', 'error', 0.5);
    observeSessionLeg('revocation', 'error', 0.1);
    observeSessionLeg('identity', 'miss', 0.03);
    expect(h.counter.inc).toHaveBeenCalledTimes(1);
    expect(h.counter.inc).toHaveBeenCalledWith({ leg: 'identity' });
  });
});
