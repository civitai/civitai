import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { minimaxVersionIds } from '~/shared/form-graph/generation/video/minimax.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const storeOn = (workflow: string, modelId: number) => {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'MiniMaxH3', prompt: 'x' });
  store.set({ model: { id: modelId } });
  return store;
};

describe('minimax H3 Max and HeyGen variants', () => {
  it('Max gets its own resolution set and an unset turbo, even after comfy turbo was on', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2vid', ecosystem: 'MiniMaxH3', prompt: 'x' });
    store.set({ turbo: true });
    store.set({ model: { id: minimaxVersionIds.max } });

    expect(store.getField('minimaxVariant')?.value).toBe('max');
    expect(store.getField('turbo')?.value).toBe(false);
    expect(store.getField('resolution')?.value).toBe('768P');
    expect(store.getField('steps')).toBeNull();
    expect(store.getField('resources')).toBeNull();
  });

  it('HeyGen gets lowercase resolutions', () => {
    const store = storeOn('txt2vid', minimaxVersionIds.heygen);

    expect(store.getField('minimaxVariant')?.value).toBe('heygen');
    expect(store.getField('resolution')?.value).toBe('768p');
    expect(store.getField('turbo')).toBeNull();
  });

  it('HeyGen img2vid offers a first-frame slot only; Max keeps first and last', () => {
    const slots = (modelId: number) =>
      (storeOn('img2vid', modelId).getField('images')?.meta as { slots?: unknown[] })?.slots;

    expect(slots(minimaxVersionIds.heygen)).toHaveLength(1);
    expect(slots(minimaxVersionIds.max)).toHaveLength(2);
  });
});
