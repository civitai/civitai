import { describe, expect, it } from 'vitest';
import { describeResidency } from '~/components/ResourceLoad/ResourceResidency';

describe('describeResidency', () => {
  it.each([
    [{ status: 'available', workers: 1 }, true],
    [{ status: 'loading', progress: 0.99, workers: 1, lane: 'low' }, false],
    [{ status: 'queued', queuePosition: 0, lane: 'low' }, false],
    [{ status: 'unavailable', queuePosition: 2 }, false],
    [{ status: 'unavailable' }, false],
  ] as const)('%o is loaded: %s', (availability, loaded) => {
    expect(describeResidency(availability)?.loaded).toBe(loaded);
  });

  it.each([[{ status: 'unsupported' }], [{ status: 'unknown' }]] as const)(
    'says nothing for %o',
    (availability) => {
      expect(describeResidency(availability)).toBeNull();
    }
  );

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

  // Only a checkpoint (base weights) can be boosted, and this note is shown for every resource, so a
  // LoRA reading it would be promised a boost the generator never offers.
  it.each([
    [{ status: 'loading', progress: 0.5, workers: 1, lane: 'low' }],
    [{ status: 'queued', queuePosition: 1, lane: 'low' }],
    [{ status: 'unavailable', queuePosition: 2 }],
    [{ status: 'unavailable' }],
  ] as const)('does not promise a boost for %o', (availability) => {
    expect(describeResidency(availability)?.description).not.toMatch(/boost/i);
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
