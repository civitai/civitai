import { describe, expect, it } from 'vitest';
import { normalizePreparation } from '~/shared/orchestrator/download-preparation';

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

  // A boost can reorder resources, so the step's boosted ETA is the slowest boosted resource — not
  // the gating one. Taking the gating resource's promised the user an ETA the boost cannot meet.
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

  it('reads a transferring gating resource as position 0 — the list reports no position then', () => {
    const result = normalizePreparation([
      { resource: checkpoint, sizeBytes: 1, lane: 'high', progress: 0.42, etaSeconds: 300 },
    ]);

    expect(result).toMatchObject({ queuePosition: 0, progress: 0.42 });
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
