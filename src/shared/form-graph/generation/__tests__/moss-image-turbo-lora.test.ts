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

function memoryStorage() {
  let saved: Record<string, unknown> = {};
  return {
    load: () => saved,
    save: (intent: unknown) => {
      saved = intent as Record<string, unknown>;
    },
    saved: () => saved,
  };
}

function mossStore(storage?: ReturnType<typeof memoryStorage>) {
  const store = generationHub.createStore({ ext: EXT, storage });
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

  // Standard values keep the address they had before turbo awareness, so values users
  // already stored still apply; turbo values get their own address beside them.
  it('persists standard values at the pre-existing address and turbo values beside them', () => {
    const storage = memoryStorage();
    const store = mossStore(storage);
    store.set({ steps: 30, cfgScale: 4 });
    store.set({ resources: [turboLora] });
    store.set({ steps: 10, cfgScale: 1.5 });

    expect(storage.saved()).toMatchObject({
      'steps@MossImage': 30,
      'cfgScale@MossImage': 4,
      'steps@MossImage/turbo': 10,
      'cfgScale@MossImage/turbo': 1.5,
    });

    const reloaded = mossStore(storage);
    expect(reloaded.getField('resources')?.value).toHaveLength(1);
    expect(values(reloaded)).toEqual({ cfgScale: 1.5, steps: 10 });
    reloaded.set({ resources: [] });
    expect(values(reloaded)).toEqual({ cfgScale: 4, steps: 30 });
  });

  // A 'MOSS Image' LoRA is not compatible with the Base variant, so turbo never engages there.
  it('on the Base variant the turbo LoRA is dropped and the standard defaults stay', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem: 'MossImage_base', prompt: 'x' });
    store.set({ resources: [turboLora] });
    expect(store.getField('resources')?.value).toEqual([]);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });
  });
});
