import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { applyGenerationData } from '../ingestion';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

const makeStore = (record?: Record<string, unknown>) =>
  generationHub.createStore({
    ext: EXT,
    storage: record ? { load: () => record, save: () => undefined } : undefined,
  });

const state = (store: ReturnType<typeof makeStore>) =>
  store.getSnapshot().state as Record<string, unknown>;

// Payloads are typed against the real signature so a GenerationData shape
// change fails to compile here; only the resource entries stay a narrow cast
// (fixtures carry the subset toResourceData reads, not full GenerationResource).
type Payload = Parameters<typeof applyGenerationData>[1];
const res = (r: Record<string, unknown>) => r as unknown as Payload['resources'][number];

describe('applyGenerationData (v1 GenerationFormProvider parity)', () => {
  it('remix: full override, but output settings survive the reset', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', quantity: 4, prompt: 'my old prompt' });
    applyGenerationData(store, {
      runType: 'remix',
      params: {
        workflow: 'txt2img',
        ecosystem: 'Illustrious',
        prompt: 'remixed prompt',
        quantity: 1, // must NOT override the user's 4
      },
      resources: [res({ id: 555, model: { type: 'Checkpoint' }, baseModel: 'Illustrious' })],
    } satisfies Payload);
    const s = state(store);
    expect(s.workflow).toBe('txt2img');
    expect(s.ecosystem).toBe('Illustrious');
    expect(s.prompt).toBe('remixed prompt');
    expect(s.quantity).toBe(4); // preserved through reset exclude
    expect((s.model as { id?: number })?.id).toBe(555);
  });

  it('remix with an unknown workflow infers from the ecosystem', () => {
    const store = makeStore();
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'some:legacy-key', ecosystem: 'SDXL', prompt: 'p' },
      resources: [],
    } satisfies Payload);
    expect(state(store).workflow).toBe('txt2img');
  });

  it('wildcard: adds the set id once, preserving snippets state', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL' });
    store.set({ snippets: { wildcardSetIds: [1], mode: 'batch', batchCount: 3, targets: {} } });
    applyGenerationData(store, {
      runType: 'wildcard',
      params: { wildcardSetId: 2 },
      resources: [],
    } satisfies Payload);
    applyGenerationData(store, {
      runType: 'wildcard',
      params: { wildcardSetId: 2 },
      resources: [],
    } satisfies Payload);
    const snippets = state(store).snippets as { wildcardSetIds: number[]; mode: string };
    expect(snippets.wildcardSetIds).toEqual([1, 2]);
    expect(snippets.mode).toBe('batch');
  });

  it('append: dedups by url against the TARGET workflow bucket, switching to it', () => {
    const img = (url: string) => ({ url, width: 512, height: 512 });
    const store = makeStore({
      workflow: 'txt2img',
      'ecosystem@image': 'SDXL',
      'images@img2img:edit': [img('a')],
    });
    applyGenerationData(store, {
      runType: 'append',
      params: { workflow: 'img2img:edit', images: [img('a'), img('b')] },
      resources: [],
    } satisfies Payload);
    const s = state(store);
    expect(s.workflow).toBe('img2img:edit');
    expect((s.images as { url: string }[]).map((i) => i.url)).toEqual(['a', 'b']);
  });

  it('run: merges resources onto compatible existing, keeping the current ecosystem', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL' });
    store.set({ resources: [{ id: 1, model: { type: 'LORA' }, baseModel: 'SDXL 1.0' }] });
    applyGenerationData(store, {
      runType: 'run',
      params: {},
      resources: [res({ id: 2, model: { type: 'LORA' }, baseModel: 'SDXL 1.0' })],
    } satisfies Payload);
    const s = state(store);
    expect(s.ecosystem).toBe('SDXL');
    expect((s.resources as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2]);
  });
});
