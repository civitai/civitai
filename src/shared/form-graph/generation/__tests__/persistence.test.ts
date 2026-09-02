import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from 'form-graph';
import { generationHub } from '../hub.graph';
import { familyScope } from '../shared';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * The persistence scope layout (v1's storage-adapter groups, as per-graph
 * scopes): family fields bucket per ecosystem group, prompt/seed/controlNets
 * stay global, the ecosystem selection buckets per output type, images per
 * workflow, and turbo-variant families refine cfg/steps per model version.
 */

const CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

function captureAdapter(): StorageAdapter & { last: () => Record<string, unknown> } {
  let saved: Record<string, unknown> = {};
  return {
    load: () => saved,
    save: (intent) => {
      saved = intent as Record<string, unknown>;
    },
    last: () => saved,
  };
}

describe('familyScope', () => {
  it('grouped ecosystems share the group id; standalone ones use their key', () => {
    expect(familyScope({ ecosystem: 'WanVideo-22-T2V-A14B' })).toBe('WanVideo');
    expect(familyScope({ ecosystem: 'Flux2Klein_9B' })).toBe('Flux2Klein');
    expect(familyScope({ ecosystem: 'SDXL' })).toBe('SDXL');
  });
});

describe('scope layout through the store', () => {
  it('family fields bucket per ecosystem; globals stay bare; ecosystem per output', () => {
    const storage = captureAdapter();
    const store = generationHub.createStore({ ext: CTX, storage });
    store.set({ ecosystem: 'SDXL', steps: 40, prompt: 'a cat', seed: 42, controlNets: [] });
    const saved = storage.last();
    expect(saved['steps@SDXL']).toBe(40);
    expect(saved['prompt']).toBe('a cat');
    expect(saved['seed']).toBe(42);
    expect(saved['ecosystem@image']).toBe('SDXL');
    expect(saved['controlNets']).toEqual([]);
  });

  it('each ecosystem bucket keeps its own memory across switches', () => {
    const store = generationHub.createStore({ ext: CTX, storage: captureAdapter() });
    store.set({ ecosystem: 'SDXL', steps: 40 });
    store.set({ ecosystem: 'Chroma' });
    store.set({ steps: 22 });
    store.set({ ecosystem: 'SDXL' });
    expect((store.getSnapshot().state as { steps?: number }).steps).toBe(40);
    store.set({ ecosystem: 'Chroma' });
    expect((store.getSnapshot().state as { steps?: number }).steps).toBe(22);
  });

  it('turbo-variant families refine cfg/steps per model version', () => {
    const storage = captureAdapter();
    const store = generationHub.createStore({ ext: CTX, storage });
    store.set({ ecosystem: 'Boogu', model: 3050010, cfgScale: 1.5 });
    expect(storage.last()['cfgScale@Boogu/3050010']).toBe(1.5);
  });

  it('images bucket per workflow', () => {
    const storage = captureAdapter();
    const store = generationHub.createStore({ ext: CTX, storage });
    store.set({ workflow: 'img2img', ecosystem: 'SDXL' });
    const images = [{ url: 'https://example.com/a.png', width: 1216, height: 832 }];
    store.set({ images });
    expect(storage.last()['images@img2img']).toEqual(images);
  });

  it('a saved record REHYDRATES: scoped values restore, per bucket', () => {
    const stored: Record<string, unknown> = {
      workflow: 'txt2img',
      'ecosystem@image': 'Chroma',
      'steps@Chroma': 22,
      'steps@SDXL': 40,
      prompt: 'a cat',
    };
    const adapter = { load: () => stored, save: () => undefined };
    const store = generationHub.createStore({ ext: CTX, storage: adapter });
    const state = store.getSnapshot().state as Record<string, unknown>;
    expect(state.ecosystem).toBe('Chroma');
    expect(state.steps).toBe(22);
    expect(state.prompt).toBe('a cat');
    // switching families reads the OTHER bucket from the same record
    store.set({ ecosystem: 'SDXL' });
    expect((store.getSnapshot().state as Record<string, unknown>).steps).toBe(40);
  });
});
