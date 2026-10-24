import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

// gold: vidQuantity equals maxQuantity, so clamping alone can't separate them
const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

describe('quantity scoped per output', () => {
  it("an image quantity doesn't carry into LTXV; each output remembers its own", () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'x' });
    store.set({ quantity: 4 });
    expect(store.getField('quantity')?.value).toBe(4);

    store.set({ workflow: 'txt2vid', ecosystem: 'LTXV23' });
    expect(store.getField('quantity')?.value).toBe(1);

    store.set({ quantity: 2 });
    store.set({ workflow: 'txt2img', ecosystem: 'Flux1' });
    expect(store.getField('quantity')?.value).toBe(4);

    store.set({ workflow: 'txt2vid', ecosystem: 'LTXV23' });
    expect(store.getField('quantity')?.value).toBe(2);
  });
});
