import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { mossImageVersionIds } from '~/shared/form-graph/generation/image/moss-image.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const turboLoraVersion = (id: number) => ({
  id,
  baseModel: 'MOSS Image',
  model: { id: 3006599, type: 'LORA' },
  strength: 1,
});
const turboLora = turboLoraVersion(3411385);
const turbo4StepLora = turboLoraVersion(3414934);
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

type MossCheckpoint = keyof typeof mossImageVersionIds;
const mossCheckpoint = (checkpoint: MossCheckpoint) => ({
  id: mossImageVersionIds[checkpoint],
  baseModel: 'MOSS Image',
  model: { id: 3005406, type: 'Checkpoint' },
});

function mossStore(storage?: ReturnType<typeof memoryStorage>, checkpoint: MossCheckpoint = 'sft') {
  const store = generationHub.createStore({ ext: EXT, storage });
  store.set({
    workflow: 'txt2img',
    ecosystem: 'MossImage',
    model: mossCheckpoint(checkpoint),
    prompt: 'x',
  });
  return store;
}

type MossStore = ReturnType<typeof mossStore>;

const values = (store: MossStore) => ({
  cfgScale: store.getField('cfgScale')?.value,
  steps: store.getField('steps')?.value,
});

const resourceIds = (store: MossStore) =>
  (store.getField('resources')?.value as { id: number }[] | undefined)?.map((r) => r.id);

type TurboToggle = { enabled: boolean; withTurbo: unknown[]; withoutTurbo: unknown[] };

const turboToggle = (store: MossStore) => {
  const turbo = (store.getField('resources')?.meta as { turbo?: TurboToggle } | undefined)?.turbo;
  if (!turbo) throw new Error('the form offers no Turbo toggle');
  return turbo;
};

/** What the Turbo checkbox does: write the next resources the graph offers. */
const setTurbo = (store: MossStore, on: boolean) => {
  const turbo = turboToggle(store);
  store.set({ resources: on ? turbo.withTurbo : turbo.withoutTurbo });
};

describe('MOSS Image Turbo toggle', () => {
  it('on SFT adds the 8-step turbo LoRA at 8 steps / CFG 1; off removes it and restores', () => {
    const store = mossStore();
    store.set({ resources: [otherLora], cfgScale: 4, steps: 30 });
    expect(turboToggle(store).enabled).toBe(false);

    setTurbo(store, true);
    expect(resourceIds(store)).toEqual([otherLora.id, 3411385]);
    expect(turboToggle(store).enabled).toBe(true);
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });
    expect(store.validate().success).toBe(true);

    setTurbo(store, false);
    expect(resourceIds(store)).toEqual([otherLora.id]);
    expect(turboToggle(store).enabled).toBe(false);
    expect(values(store)).toEqual({ cfgScale: 4, steps: 30 });
  });

  it('on Base adds the Base 8-step turbo LoRA', () => {
    const store = mossStore(undefined, 'base');
    setTurbo(store, true);
    expect(resourceIds(store)).toEqual([3413516]);
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });
    expect(store.validate().success).toBe(true);
  });

  it('is disabled when every resource slot is taken, but can still be turned off', () => {
    const store = mossStore();
    const loras = Array.from({ length: EXT.limits.maxResources }, (_, i) => ({
      ...otherLora,
      id: otherLora.id + i,
    }));
    store.set({ resources: loras });
    expect(turboToggle(store)).toMatchObject({ enabled: false, full: true });

    store.set({ resources: [...loras.slice(1), turboLora] });
    expect(turboToggle(store)).toMatchObject({ enabled: true, full: false });
  });

  it("switching checkpoint keeps Turbo on with that checkpoint's turbo LoRA", () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    setTurbo(store, true);

    store.set({ model: mossCheckpoint('base') });
    expect(resourceIds(store)).toEqual([otherLora.id, 3413516]);
    expect(turboToggle(store).enabled).toBe(true);
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });

    store.set({ model: mossCheckpoint('sft') });
    expect(resourceIds(store)).toEqual([otherLora.id, 3411385]);
    expect(turboToggle(store).enabled).toBe(true);
  });

  it('on SFT swaps a Base turbo LoRA for the SFT one', () => {
    const store = mossStore();
    store.set({ resources: [turboLoraVersion(3413516)] });
    expect(resourceIds(store)).toEqual([3411385]);
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });
  });

  // The server parse sees no model.id; the Base LoRA must still be removed, not kept beside.
  it('the server parse swaps a Base turbo LoRA on SFT without stacking both', () => {
    const parsed = generationHub.parse(
      {
        workflow: 'txt2img',
        ecosystem: 'MossImage',
        prompt: 'x',
        resources: [{ id: 3413516, baseModel: 'MOSS Image', model: { type: 'LORA' } }],
      },
      EXT
    ) as { success: boolean; data?: { resources: { id: number }[] } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.resources.map((r) => r.id)).toEqual([3411385]);
  });

  it('keeps the strength of a turbo LoRA already present for this checkpoint', () => {
    const store = mossStore(undefined, 'base');
    store.set({
      resources: [
        { ...turboLora, strength: 0.8 },
        { ...turboLoraVersion(3413516), strength: 0.6 },
      ],
    });
    expect(store.getField('resources')?.value).toEqual([
      expect.objectContaining({ id: 3413516, strength: 0.6 }),
    ]);
  });

  it('leaves the 4-step version alone on SFT', () => {
    const store = mossStore();
    store.set({ resources: [turbo4StepLora] });
    expect(resourceIds(store)).toEqual([turbo4StepLora.id]);
    expect(values(store).steps).toBe(4);
  });

  it('shows as on for a hand-added turbo LoRA of any version, and off removes it', () => {
    const store = mossStore();
    store.set({ resources: [turbo4StepLora, otherLora] });
    expect(turboToggle(store).enabled).toBe(true);

    setTurbo(store, false);
    expect(resourceIds(store)).toEqual([otherLora.id]);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });
  });
});

describe('MOSS Image turbo steps per LoRA version', () => {
  it.each([
    [3411385, 'sft', 8],
    [3413516, 'base', 8],
    [3414934, 'sft', 4],
    [9999999, 'sft', 8], // a future version uploaded to the same page
  ] as const)('version %i on %s defaults to its own step count', (id, checkpoint, steps) => {
    const store = mossStore(undefined, checkpoint);
    store.set({ resources: [turboLoraVersion(id)] });
    expect(resourceIds(store)).toEqual([id]);
    expect(values(store)).toEqual({ cfgScale: 1, steps });
  });

  it('each turbo version remembers its own steps, across a reload', () => {
    const storage = memoryStorage();
    const store = mossStore(storage);
    store.set({ resources: [turboLora] });
    store.set({ steps: 10 });

    store.set({ resources: [turbo4StepLora] });
    expect(values(store).steps).toBe(4);
    store.set({ steps: 5 });

    store.set({ resources: [turboLora] });
    expect(values(store).steps).toBe(10);
    store.set({ resources: [turbo4StepLora] });
    expect(values(store).steps).toBe(5);

    const reloaded = mossStore(storage);
    expect(values(reloaded).steps).toBe(5);
    reloaded.set({ resources: [turboLora] });
    expect(values(reloaded).steps).toBe(10);
  });
});

describe('MOSS Image turbo CFG', () => {
  it('keeps the remembered turbo CFG across Turbo off/on and a turbo version swap', () => {
    const store = mossStore();
    store.set({ cfgScale: 4 });
    setTurbo(store, true);
    store.set({ cfgScale: 3 });

    setTurbo(store, false);
    expect(values(store).cfgScale).toBe(4);

    setTurbo(store, true);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 8 });

    store.set({ resources: [turbo4StepLora] });
    expect(values(store)).toEqual({ cfgScale: 3, steps: 4 });
  });
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

  it('a non-turbo LoRA, or an unknown resource with no model, leaves the defaults alone', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    expect(store.getField('resources')?.value).toHaveLength(1);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });

    store.set({ resources: [{ id: otherLora.id }] });
    expect(store.getField('resources')?.value).toHaveLength(1);
    expect(values(store)).toEqual({ cfgScale: 3, steps: 25 });
  });

  // The shape the server parses: the output schema drops model.id.
  it('recognises a known turbo version by id alone', () => {
    const store = mossStore();
    store.set({ resources: [{ id: turbo4StepLora.id, model: { type: 'LORA' } }] });
    expect(values(store)).toEqual({ cfgScale: 1, steps: 4 });
  });

  // Standard values keep the address they had before turbo awareness, so values users
  // already stored still apply; turbo values get their own address beside them, steps
  // one per turbo LoRA version.
  it('persists standard values at the pre-existing address and turbo values beside them', () => {
    const storage = memoryStorage();
    const store = mossStore(storage);
    store.set({ steps: 30, cfgScale: 4 });
    store.set({ resources: [turboLora] });
    store.set({ steps: 10, cfgScale: 1.5 });

    expect(storage.saved()).toMatchObject({
      'steps@MossImage': 30,
      'cfgScale@MossImage': 4,
      'steps@MossImage/turbo/3411385': 10,
      'cfgScale@MossImage/turbo': 1.5,
    });

    const reloaded = mossStore(storage);
    expect(reloaded.getField('resources')?.value).toHaveLength(1);
    expect(values(reloaded)).toEqual({ cfgScale: 1.5, steps: 10 });
    reloaded.set({ resources: [] });
    expect(values(reloaded)).toEqual({ cfgScale: 4, steps: 30 });
  });

  // Base has its own turbo version; every other LoRA runs on either checkpoint.
  it('on the Base checkpoint an SFT turbo LoRA becomes the Base one; other LoRAs stay', () => {
    const store = mossStore(undefined, 'base');
    store.set({ resources: [otherLora, turbo4StepLora] });
    expect(resourceIds(store)).toEqual([otherLora.id, 3413516]);
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });
  });
});
