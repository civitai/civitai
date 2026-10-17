import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const turboLora = {
  id: 3411385,
  baseModel: 'MOSS Image',
  model: { id: 3006599, type: 'LORA' },
  strength: 1,
};
const otherLora = {
  id: 9000001,
  baseModel: 'MOSS Image',
  model: { id: 9000000, type: 'LORA' },
  strength: 1,
};

function mossStore() {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'txt2img', ecosystem: 'MossImage', prompt: 'x' });
  return store;
}

const values = (store: ReturnType<typeof mossStore>) => ({
  cfgScale: store.getField('cfgScale')?.value,
  steps: store.getField('steps')?.value,
});

describe('MOSS Image turbo LoRA steps/CFG', () => {
  it('starts at the standard defaults', () => {
    expect(values(mossStore())).toEqual({ cfgScale: 3, steps: 25 });
  });

  it('adding a turbo LoRA applies 8 steps / CFG 1; removing it restores the standard values', () => {
    const store = mossStore();
    store.set({ cfgScale: 4, steps: 30 });

    store.set({ resources: [turboLora] });
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });

    store.set({ resources: [] });
    expect(values(store)).toEqual({ cfgScale: 4, steps: 30 });
    expect(store.validate().success).toBe(true);
  });

  it('remembers the turbo values the user edited across remove/re-add', () => {
    const store = mossStore();
    store.set({ resources: [turboLora] });
    store.set({ cfgScale: 1.5, steps: 10 });

    store.set({ resources: [] });
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });

    store.set({ resources: [turboLora] });
    expect(values(store)).toEqual({ cfgScale: 1.5, steps: 10 });
  });

  it('stays turbo until the LAST turbo LoRA is removed', () => {
    const store = mossStore();
    store.set({ resources: [otherLora, turboLora] });
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });

    store.set({ resources: [turboLora] });
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });

    store.set({ resources: [otherLora] });
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });
  });

  it('a non-turbo LoRA, or a resource with no model, leaves the defaults alone', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    expect(store.getField('resources')?.value).toHaveLength(1);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });

    store.set({ resources: [{ id: turboLora.id }] });
    expect(store.getField('resources')?.value).toHaveLength(1);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });
  });
});
