import { describe, expect, it } from 'vitest';
import {
  attachEstimatedPreparation,
  ETA_WARMUP_PROGRESS,
  isEtaSettled,
  normalizePreparation,
  settledBoostedEtaSeconds,
  settledEtaSeconds,
} from '~/shared/orchestrator/download-preparation';

const checkpoint = 'urn:air:flux1:checkpoint:civitai:978314@1413133';
const vae = 'urn:air:flux1:vae:civitai:1@2';

describe('normalizePreparation', () => {
  it('summarises the list from the gating resource (the first)', () => {
    const result = normalizePreparation([
      {
        resource: checkpoint,
        sizeBytes: 23_802_909_696,
        lane: 'low',
        queuePosition: 3,
        etaSeconds: 10_136,
        boostedEtaSeconds: 9_665,
      },
      { resource: vae, sizeBytes: 335_000_000, lane: 'low', queuePosition: 1, etaSeconds: 90 },
    ]);

    expect(result).toMatchObject({
      resource: checkpoint,
      queuePosition: 3,
      etaSeconds: 10_136,
      lane: 'low',
      boostedEtaSeconds: 9_665,
    });
    expect(result?.resources).toHaveLength(2);
  });

  // A boost can reorder resources, so the boosted ETA is the slowest boosted resource. Taking the
  // gating resource's promises an ETA the boost cannot meet.
  it('takes the boosted ETA from the slowest resource once boosted, not from the gating one', () => {
    const result = normalizePreparation([
      {
        resource: checkpoint,
        sizeBytes: 1,
        lane: 'low',
        queuePosition: 4,
        etaSeconds: 3_000,
        boostedEtaSeconds: 200,
      },
      {
        resource: vae,
        sizeBytes: 1,
        lane: 'low',
        queuePosition: 2,
        etaSeconds: 1_000,
        boostedEtaSeconds: 900,
      },
    ]);

    expect(result?.boostedEtaSeconds).toBe(900);
    expect(result?.etaSeconds).toBe(3_000);
  });

  it('reads no boosted ETA when no resource reports one — the workflow is already high', () => {
    const result = normalizePreparation([
      { resource: checkpoint, sizeBytes: 1, lane: 'high', queuePosition: 1, etaSeconds: 60 },
    ]);

    expect(result?.boostedEtaSeconds).toBeNull();
  });

  // A transferring resource reports no position, and "no position" is not position zero — reading it
  // as 0 is what had the lanes popover claiming "downloading now" for a job that had not started.
  it('reads a transferring gating resource as having no position', () => {
    const result = normalizePreparation([
      { resource: checkpoint, sizeBytes: 1, lane: 'high', progress: 0.42, etaSeconds: 300 },
    ]);

    expect(result).toMatchObject({ queuePosition: null, progress: 0.42 });
  });

  // Truthy `[]` is the bug this guards: a download panel and a paid Boost on a step with nothing
  // waiting.
  it('reads an empty list as nothing to download', () => {
    expect(normalizePreparation([])).toBeUndefined();
  });

  // One malformed element would otherwise put undefined fields on the queue card.
  it('reads a list with a malformed resource as nothing to download', () => {
    expect(normalizePreparation([{ resource: checkpoint, lane: 'low' }])).toBeUndefined();
  });

  it.each([null, undefined, 'nope', 42, {}, { resource: checkpoint, queuePosition: 1 }])(
    'reads %s as nothing to download',
    (raw) => {
      expect(normalizePreparation(raw)).toBeUndefined();
    }
  );
});

describe('attachEstimatedPreparation', () => {
  const estimate = normalizePreparation([
    {
      resource: checkpoint,
      sizeBytes: 1,
      lane: 'low',
      queuePosition: 3,
      etaSeconds: 600,
      boostedEtaSeconds: 60,
      rateLimitBytesPerSecond: 5,
    },
  ])!;

  // Lane and size are properties of the request; position and ETA are measured against a queue this
  // job has not joined, so showing them would assert a number the orchestrator then changes.
  it('gives a submit reply the lane and sizes, and none of the queue figures', () => {
    const steps: { name: string; preparation?: typeof estimate }[] = [{ name: '$0' }];
    attachEstimatedPreparation(steps, [{ name: '$0', preparation: estimate }], false);
    expect(steps[0].preparation).toMatchObject({ lane: 'low' });
    expect(steps[0].preparation?.resources[0].sizeBytes).toBe(1);
    expect(steps[0].preparation?.queuePosition).toBeNull();
    expect(steps[0].preparation?.etaSeconds).toBeNull();
    expect(steps[0].preparation?.boostedEtaSeconds).toBeNull();
    expect(steps[0].preparation?.resources[0].etaSeconds).toBeNull();
  });

  // Matching by index alone puts the checkpoint's lane on whichever step happens to come first.
  it('attaches to the step the whatIf priced, not the one at its index', () => {
    const steps: { name: string; preparation?: typeof estimate }[] = [
      { name: '$1' },
      { name: '$0' },
    ];
    attachEstimatedPreparation(steps, [{ name: '$0', preparation: estimate }], false);
    expect(steps[1].preparation).toBeDefined();
    expect(steps[0].preparation).toBeUndefined();
  });

  it('never replaces what the orchestrator already reported', () => {
    const reported = { ...estimate, queuePosition: 9 };
    const steps = [{ name: '$0', preparation: reported }];
    attachEstimatedPreparation(steps, [{ name: '$0', preparation: estimate }], false);
    expect(steps[0].preparation).toBe(reported);
  });

  // The whatIf behind a boosted submit is priced unboosted; showing its low lane and unboosted ETA
  // would tell the buyer the boost bought nothing.
  it('restates a boosted submit’s estimate in the high lane', () => {
    const steps: { name: string; preparation?: typeof estimate }[] = [{ name: '$0' }];
    attachEstimatedPreparation(steps, [{ name: '$0', preparation: estimate }], true);
    expect(steps[0].preparation).toMatchObject({
      lane: 'high',
      boostedEtaSeconds: null,
      rateLimitBytesPerSecond: null,
    });
    expect(steps[0].preparation?.resources[0]).toMatchObject({ lane: 'high' });
  });
});

describe('warm-up suppression', () => {
  it('drops the ETA of a transfer that has barely started', () => {
    const result = normalizePreparation([
      {
        resource: checkpoint,
        sizeBytes: 4_000_000_000,
        lane: 'low',
        progress: 0.001,
        etaSeconds: 7_200,
      },
    ]);

    expect(result).toMatchObject({ progress: 0.001, etaSeconds: null });
  });

  it('believes it again once the transfer is under way', () => {
    const result = normalizePreparation([
      {
        resource: checkpoint,
        sizeBytes: 4_000_000_000,
        lane: 'low',
        progress: 0.2,
        etaSeconds: 600,
      },
    ]);

    expect(result?.etaSeconds).toBe(600);
  });

  it('leaves a queued resource’s ETA alone while another warms up', () => {
    const result = normalizePreparation([
      {
        resource: checkpoint,
        sizeBytes: 4_000_000_000,
        lane: 'low',
        progress: 0.001,
        etaSeconds: 7_200,
      },
      { resource: vae, sizeBytes: 4_000_000_000, lane: 'low', queuePosition: 2, etaSeconds: 600 },
    ]);

    expect(result?.etaSeconds).toBe(600);
  });
});

describe('isEtaSettled', () => {
  // A model waiting behind other downloads was given a projection nothing has distorted; only a
  // transfer in progress can be too young to believe.
  it('believes a resource that has not started downloading', () => {
    expect(isEtaSettled({ sizeBytes: 20_000_000_000 })).toBe(true);
    expect(isEtaSettled({ progress: null, sizeBytes: 20_000_000_000 })).toBe(true);
  });

  it('does not believe a transfer under both thresholds', () => {
    expect(isEtaSettled({ progress: 0.001, sizeBytes: 1_000_000_000 })).toBe(false);
  });

  it('believes one past the progress threshold', () => {
    expect(isEtaSettled({ progress: 0.05, sizeBytes: 1_000_000_000 })).toBe(true);
  });

  // 0.5% of 20GB is 100MB — a large enough sample to trust, and the fraction alone would stay quiet
  // for minutes on a rate-capped lane.
  it('believes one that has moved enough bytes to sample, whatever the fraction', () => {
    expect(isEtaSettled({ progress: 0.005, sizeBytes: 20_000_000_000 })).toBe(true);
  });

  // The fraction alone is met almost immediately on a small file, which is where an ETA was being
  // projected from a still-ramping stream and quoting hours on a download of minutes.
  it('does not believe a small transfer that has only met the fraction', () => {
    expect(isEtaSettled({ progress: ETA_WARMUP_PROGRESS, sizeBytes: 30_000_000 })).toBe(false);
    expect(isEtaSettled({ progress: 0.1, sizeBytes: 30_000_000 })).toBe(false);
  });

  it('still settles a file smaller than the byte floor', () => {
    expect(isEtaSettled({ progress: 0.6, sizeBytes: 4_000_000 })).toBe(true);
  });

  // The sizes the boost is actually sold against keep the thresholds they had.
  it('leaves large transfers where they were', () => {
    expect(isEtaSettled({ progress: 0.019, sizeBytes: 1_000_000_000 })).toBe(false);
    expect(isEtaSettled({ progress: 0.021, sizeBytes: 1_000_000_000 })).toBe(true);
  });

  it('falls back to the fraction when the size is unknown', () => {
    expect(isEtaSettled({ progress: 0.01 })).toBe(false);
    expect(isEtaSettled({ progress: 0.05 })).toBe(true);
  });
});

describe('settledBoostedEtaSeconds', () => {
  // Offering a paid boost while refusing to show the wait it shortens is a charge with no benefit on
  // screen, so both ETAs are withheld on the same terms.
  it('withholds the boosted ETA on the same terms as the plain one', () => {
    const warming = { progress: 0.001, sizeBytes: 1_000, etaSeconds: 7_200, boostedEtaSeconds: 60 };
    expect(settledBoostedEtaSeconds(warming)).toBeNull();
    expect(settledEtaSeconds(warming)).toBeNull();
  });

  it('keeps it for a model that has not started downloading', () => {
    expect(settledBoostedEtaSeconds({ etaSeconds: 600, boostedEtaSeconds: 60 })).toBe(60);
  });
});
