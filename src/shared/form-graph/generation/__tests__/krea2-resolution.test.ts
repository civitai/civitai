import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { krea2VersionIds } from '~/shared/form-graph/generation/image/krea2.graph';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * Krea 2's 2K tier fits inside the comfy input's limits instead of doubling past them.
 *
 * Ported from `src/shared/data-graph/generation/krea2-graph.test.ts`, which this branch
 * deletes with the lane. The fix it pins landed on BOTH lanes (`feat(generator): saved custom
 * sizes, Krea 2 custom sizes, and a working 2K tier`) but the test landed only on the
 * data-graph one, so deleting that file would have dropped the only assertion covering it —
 * a straight doubling sent 16:9 as 2752 × 1536, past 2048 per side, and the orchestrator
 * refused every 2K ratio but 1:1.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

function store(versionId: number) {
  const s = generationHub.createStore({ ext: EXT });
  s.set({ workflow: 'txt2img', ecosystem: 'Krea2', prompt: 'a cat' });
  s.set({ model: { id: versionId, model: { type: 'Checkpoint' } } });
  return s;
}

const dims = (s: ReturnType<typeof store>) => {
  const ar = (s.getSnapshot().state as Record<string, unknown>).aspectRatio as {
    width: number;
    height: number;
  };
  return { width: ar.width, height: ar.height };
};

describe('krea2 resolution tiers', () => {
  it('fits 2K inside 2048 per side, keeping the ratio and /32', () => {
    const s = store(krea2VersionIds.turbo);
    s.set({ resolution: '2K', aspectRatio: '16:9' });

    expect(dims(s)).toEqual({ width: 2048, height: 1152 });
    const { width, height } = dims(s);
    expect(width % 32).toBe(0);
    expect(height % 32).toBe(0);
  });

  // The control for the row above: without it, a hook that forced every tier to 2048×1152
  // would pass. 1K is the untouched baseline.
  it('leaves 1K at its own bucket', () => {
    const s = store(krea2VersionIds.turbo);
    s.set({ resolution: '1K', aspectRatio: '1:1' });

    expect(dims(s)).toEqual({ width: 1024, height: 1024 });
  });
});
