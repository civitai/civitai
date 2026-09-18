import { describe, expect, it } from 'vitest';
import { describeResidency } from '~/components/ResourceLoad/ResourceResidency';

describe('describeResidency', () => {
  it('quotes a settled transfer’s ETA', () => {
    const residency = describeResidency({
      status: 'loading',
      progress: 0.4,
      workers: 1,
      lane: 'low',
      etaSeconds: 600,
    });

    expect(residency?.label).toBe('Downloading 40%');
    expect(residency?.description).toContain('Ready in about 10 minutes.');
  });

  // This surface reads the shared per-model status directly rather than through either summarizer, so
  // it is the one place the warm-up rule has to be applied by hand.
  it('quotes none from a transfer that has barely started', () => {
    const residency = describeResidency({
      status: 'loading',
      progress: 0.001,
      workers: 1,
      lane: 'low',
      etaSeconds: 7_200,
    });

    expect(residency?.label).toBe('Downloading 0%');
    expect(residency?.description).not.toContain('Ready in');
  });

  it('quotes a queued model’s ETA, which no transfer has skewed', () => {
    const residency = describeResidency({
      status: 'queued',
      queuePosition: 2,
      lane: 'low',
      etaSeconds: 600,
    });

    expect(residency?.description).toContain('Ready in about 10 minutes.');
  });

  it('never advertises sooner than the floor', () => {
    const residency = describeResidency({
      status: 'queued',
      queuePosition: 1,
      lane: 'high',
      etaSeconds: 5,
    });

    expect(residency?.description).toContain('Ready in about 2 minutes.');
  });
});
