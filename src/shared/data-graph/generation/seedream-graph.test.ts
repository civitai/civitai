import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import { seedreamVersionIds } from './seedream-graph';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

function init(modelId: number, resolution?: string) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow: 'txt2img',
      ecosystem: 'Seedream',
      model: { id: modelId, baseModel: 'Seedream', model: { type: 'Checkpoint' } },
      ...(resolution ? { resolution } : {}),
    },
    ext
  );
  return graph;
}

const dims = (g: any) => {
  const o = g.getSnapshot('aspectRatio').meta.options.find((x: any) => x.value === '1:1');
  return `${o.width}x${o.height}`;
};

describe('seedream resolution toggle', () => {
  // `hasNode` is what `useGraphSubscription` checks; a missing node makes
  // `Controller` render null, which is how the toggle disappears from the form.
  it('hides the toggle for v5.0-pro and shows it for v4.5 / v5.0-lite', () => {
    expect(init(seedreamVersionIds['v5.0-pro']).hasNode('resolution')).toBe(false);
    expect(init(seedreamVersionIds['v4.5']).hasNode('resolution')).toBe(true);
    expect(init(seedreamVersionIds['v5.0-lite']).hasNode('resolution')).toBe(true);
  });

  it('v5.0-pro renders 2K dimensions even with a stale stored 4K value', () => {
    expect(dims(init(seedreamVersionIds['v5.0-pro']))).toBe('2048x2048');
    expect(dims(init(seedreamVersionIds['v5.0-pro'], '4K'))).toBe('2048x2048');
  });

  it('v4.5 still honors 4K', () => {
    expect(dims(init(seedreamVersionIds['v4.5'], '4K'))).toBe('4096x4096');
    expect(dims(init(seedreamVersionIds['v4.5'], '2K'))).toBe('2048x2048');
  });

  it('switching from v4.5@4K to v5.0-pro drops back to 2K', () => {
    const g = init(seedreamVersionIds['v4.5'], '4K');
    expect(dims(g)).toBe('4096x4096');
    g.set({ model: { id: seedreamVersionIds['v5.0-pro'], model: { type: 'Checkpoint' } } });
    expect(dims(g)).toBe('2048x2048');
  });
});
