import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { mossImageVersionIds } from '~/shared/form-graph/generation/image/moss-image.graph';
import { additionalResources, turboLoraValue } from '~/shared/form-graph/generation/turbo';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

// The family default (SFT 8-step) and the LoRA Base names on its own version settings.
const SFT_TURBO = 3411385;
const BASE_TURBO = 3413516;

/** A hydrated turbo LoRA the picker would hand back, with a band that reaches below the graph's floor. */
const communityTurbo = {
  id: 9000002,
  baseModel: 'MOSS Image',
  model: { id: 9000000, type: 'LORA' },
  strength: 1,
  turbo: true,
  recommendedSettings: {
    steps: { min: 2, max: 6, default: 4 },
    cfgScale: { min: 1, max: 1, default: 1 },
  },
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

type MossCheckpoint = keyof typeof mossImageVersionIds;
const mossCheckpoint = (checkpoint: MossCheckpoint, extra: Record<string, unknown> = {}) => ({
  id: mossImageVersionIds[checkpoint],
  baseModel: 'MOSS Image',
  model: { id: 3005406, type: 'Checkpoint' },
  ...extra,
});

function mossStore(
  storage?: ReturnType<typeof memoryStorage>,
  checkpoint: MossCheckpoint = 'sft',
  modelExtra: Record<string, unknown> = {}
) {
  const store = generationHub.createStore({ ext: EXT, storage });
  store.set({
    workflow: 'txt2img',
    ecosystem: 'MossImage',
    model: mossCheckpoint(checkpoint, modelExtra),
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

const turboLoraId = (store: MossStore) =>
  (store.getField('turboLora')?.value as { id: number } | undefined)?.id;

type TurboToggle = {
  enabled: boolean;
  full: boolean;
  withoutTurbo: unknown[];
};

const turboToggle = (store: MossStore) => {
  const turbo = (store.getField('resources')?.meta as { turbo?: TurboToggle } | undefined)?.turbo;
  if (!turbo) throw new Error('the form offers no Turbo toggle');
  return turbo;
};

/** What the Turbo checkbox does: add the pick to, or strip turbo LoRAs from, the resources. */
const setTurbo = (store: MossStore, on: boolean) => {
  const turbo = turboToggle(store);
  const pick = store.getField('turboLora')?.value as { id: number } | undefined;
  if (on && !pick) throw new Error('no pick to add');
  store.set({ resources: on ? [...turbo.withoutTurbo, pick] : turbo.withoutTurbo });
};

const stepsMeta = (store: MossStore) =>
  store.getField('steps')?.meta as
    | { min: number; max: number; recommended?: { min: number; max: number } }
    | undefined;

describe('MOSS Image Turbo toggle', () => {
  // A checkpoint's own choice rides on its hydrated data; a bare id gets the family default.
  it.each([
    ['SFT', 'sft', {}, SFT_TURBO],
    ['Base, not hydrated yet', 'base', {}, SFT_TURBO],
    ['Base with its own', 'base', { settings: { turboLora: { id: BASE_TURBO } } }, BASE_TURBO],
    [
      'SFT with its own choice',
      'sft',
      { settings: { turboLora: { id: communityTurbo.id } } },
      communityTurbo.id,
    ],
  ] as const)('%s starts on the right turbo LoRA', (_, checkpoint, extra, expected) => {
    expect(turboLoraId(mossStore(undefined, checkpoint, extra))).toBe(expected);
  });

  it("the checkpoint's strength for its default LoRA rides the pick onto the request", () => {
    const store = mossStore(undefined, 'sft', {
      settings: { turboLora: { id: communityTurbo.id, strength: 0.6 } },
    });
    setTurbo(store, true);
    const added = (store.getField('resources')?.value as { id: number; strength?: number }[]).find(
      (r) => r.id === communityTurbo.id
    );
    expect(added?.strength).toBe(0.6);
  });

  it('on adds the LoRA at its steps and CFG, paints the band; off removes it and restores', () => {
    const store = mossStore();
    store.set({ resources: [otherLora], cfgScale: 4, steps: 30 });
    expect(turboToggle(store).enabled).toBe(false);
    expect(stepsMeta(store)?.recommended).toBeUndefined();

    setTurbo(store, true);
    expect(resourceIds(store)).toEqual([otherLora.id, SFT_TURBO]);
    expect(turboToggle(store).enabled).toBe(true);
    // The default LoRA is not hydrated in the store, so the ecosystem's turbo settings apply.
    expect(values(store)).toEqual({ cfgScale: 1, steps: 8 });
    expect(stepsMeta(store)?.recommended).toEqual({ min: 4, max: 8 });
    expect(store.validate().success).toBe(true);

    setTurbo(store, false);
    expect(resourceIds(store)).toEqual([otherLora.id]);
    expect(values(store)).toEqual({ cfgScale: 4, steps: 30 });
    expect(stepsMeta(store)?.recommended).toBeUndefined();
  });

  it('a hydrated pick applies its own band, clamped to the graph range', () => {
    const store = mossStore();
    store.set({ turboLora: communityTurbo, resources: [communityTurbo] });
    expect(turboToggle(store).enabled).toBe(true);
    expect(values(store)).toEqual({ cfgScale: 1, steps: 4 });
    expect(stepsMeta(store)).toMatchObject({ min: 4, max: 60, recommended: { min: 4, max: 6 } });
  });

  it('cannot be turned on when every resource slot is taken, and still turns off', () => {
    const store = mossStore();
    const loras = Array.from({ length: EXT.limits.maxResources }, (_, i) => ({
      ...otherLora,
      id: otherLora.id + 100 + i,
    }));
    store.set({ resources: loras });
    expect(turboToggle(store)).toMatchObject({ enabled: false, full: true });

    store.set({ resources: [...loras.slice(1), communityTurbo] });
    expect(turboToggle(store)).toMatchObject({ enabled: true, full: false });
    setTurbo(store, false);
    expect(resourceIds(store)).toHaveLength(loras.length - 1);
  });

  it("switching checkpoint keeps Turbo on with that checkpoint's default LoRA", () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    setTurbo(store, true);

    store.set({ model: mossCheckpoint('base', { settings: { turboLora: { id: BASE_TURBO } } }) });
    expect(turboLoraId(store)).toBe(BASE_TURBO);
    expect(resourceIds(store)).toEqual([otherLora.id, BASE_TURBO]);
    expect(turboToggle(store).enabled).toBe(true);

    store.set({ model: mossCheckpoint('sft') });
    expect(resourceIds(store)).toEqual([otherLora.id, SFT_TURBO]);
    expect(turboToggle(store).enabled).toBe(true);
  });

  it('the checkpoint swap leaves a hand-picked turbo LoRA alone', () => {
    const store = mossStore();
    store.set({ resources: [communityTurbo] });
    store.set({ model: mossCheckpoint('base') });
    expect(resourceIds(store)).toEqual([communityTurbo.id]);
  });

  // A remix sets model and resources in one patch; its LoRA is the user's choice, not a default to swap.
  it('a remix keeps its turbo LoRA across the checkpoint switch and makes it the pick', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    setTurbo(store, true);
    store.set({
      model: mossCheckpoint('base', { settings: { turboLora: { id: BASE_TURBO } } }),
      resources: [communityTurbo],
    });
    expect(resourceIds(store)).toEqual([communityTurbo.id]);
    expect(turboLoraId(store)).toBe(communityTurbo.id);
  });

  it('the checkpoint swap does not add a default that is already in the list', () => {
    const store = mossStore();
    store.set({ resources: [otherLora, turboLoraValue(SFT_TURBO), turboLoraValue(BASE_TURBO)] });
    store.set({ model: mossCheckpoint('base', { settings: { turboLora: { id: BASE_TURBO } } }) });
    expect(resourceIds(store)).toEqual([otherLora.id, BASE_TURBO]);
  });

  // The old default itself can arrive with a remix; the swap must not treat it as its own.
  it('a remix that brings the old default LoRA keeps it across the switch', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    setTurbo(store, true);
    store.set({
      model: mossCheckpoint('base', { settings: { turboLora: { id: BASE_TURBO } } }),
      resources: [otherLora, turboLoraValue(SFT_TURBO)],
    });
    expect(resourceIds(store)).toEqual([otherLora.id, SFT_TURBO]);
  });

  it('a second turbo LoRA replaces the first and becomes the pick', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    setTurbo(store, true);
    store.set({ resources: [otherLora, turboLoraValue(SFT_TURBO), communityTurbo] });
    expect(resourceIds(store)).toEqual([otherLora.id, communityTurbo.id]);
    expect(turboLoraId(store)).toBe(communityTurbo.id);
    const request = store.validate();
    expect(request.success && request.data.resources?.map((r) => r.id)).toEqual([
      otherLora.id,
      communityTurbo.id,
    ]);
    setTurbo(store, false);
    expect(resourceIds(store)).toEqual([otherLora.id]);
    expect(turboToggle(store).enabled).toBe(false);
  });

  // Form state saved before the flag carries the band where the flag now goes.
  it('a turbo LoRA stored with the old band in place of the flag still counts and validates', () => {
    const store = mossStore();
    const { turbo: _flag, ...stored } = communityTurbo;
    void _flag;
    store.set({ resources: [{ ...stored, turbo: communityTurbo.recommendedSettings }] });
    expect(turboToggle(store).enabled).toBe(true);
    const request = store.validate();
    expect(request.success && request.data.resources?.[0]?.turbo).toBe(true);
  });

  // The server parses the request through the same graph.
  it('the server keeps one turbo LoRA from a request that sends two', () => {
    const parsed = generationHub.parse(
      {
        workflow: 'txt2img',
        ecosystem: 'MossImage',
        model: mossCheckpoint('sft'),
        prompt: 'x',
        resources: [otherLora, turboLoraValue(SFT_TURBO), communityTurbo],
      },
      EXT
    );
    expect(parsed.success && parsed.data.resources?.map((r) => r.id)).toEqual([
      otherLora.id,
      communityTurbo.id,
    ]);
  });

  it('the Additional Resources list hides the turbo LoRA and gives it back on every edit', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    setTurbo(store, true);
    const resources = store.getField('resources')?.value as { id: number }[];
    const list = additionalResources(turboToggle(store), resources, EXT.limits.maxResources);
    expect(list.value?.map((r) => r.id)).toEqual([otherLora.id]);
    expect(list.limit).toBe(EXT.limits.maxResources - 1);

    const second = { ...otherLora, id: otherLora.id + 1 };
    store.set({ resources: list.commit([otherLora, second]) });
    expect(resourceIds(store)).toEqual([otherLora.id, second.id, SFT_TURBO]);
    expect(turboToggle(store).enabled).toBe(true);

    const bare = additionalResources(undefined, resources, EXT.limits.maxResources);
    expect(bare.value).toBe(resources);
    expect(bare.limit).toBe(EXT.limits.maxResources);
  });

  it('Additional Resources offers no turbo LoRAs, so the toggle is the only way in', () => {
    const options = (store: MossStore) =>
      (store.getField('resources')?.meta as { options: { excludeTurbo?: boolean } }).options;
    expect(options(mossStore()).excludeTurbo).toBe(true);
    const plain = generationHub.createStore({ ext: EXT });
    plain.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'x' });
    expect(options(plain as MossStore).excludeTurbo).toBeUndefined();
  });

  // A remix can bring a turbo LoRA in without the picker.
  it('a turbo LoRA arriving in resources becomes the pick, so off and on re-adds it', () => {
    const store = mossStore();
    store.set({ resources: [otherLora, communityTurbo] });
    expect(turboLoraId(store)).toBe(communityTurbo.id);
    setTurbo(store, false);
    expect(turboLoraId(store)).toBe(communityTurbo.id);
    setTurbo(store, true);
    expect(resourceIds(store)).toEqual([otherLora.id, communityTurbo.id]);
  });

  it('remembers the pick and the turbo values per checkpoint across a reload', () => {
    const storage = memoryStorage();
    const first = mossStore(storage);
    first.set({ turboLora: communityTurbo, resources: [communityTurbo], steps: 6 });
    first.set({ model: mossCheckpoint('base', { settings: { turboLora: { id: BASE_TURBO } } }) });
    expect(turboLoraId(first)).toBe(BASE_TURBO);

    const second = mossStore(storage);
    expect(turboLoraId(second)).toBe(communityTurbo.id);
    expect(values(second).steps).toBe(6);
  });

  // The server reads the LoRA off `resources`; the pick is client memory, never a request field.
  it('the pick never rides the request, on or off', () => {
    const store = mossStore();
    store.set({ resources: [otherLora] });
    const off = store.validate();
    expect(off.success).toBe(true);
    expect(off.success && off.data.turboLora).toBeUndefined();

    setTurbo(store, true);
    const on = store.validate();
    expect(on.success && on.data.turboLora).toBeUndefined();
    expect(on.success && on.data.resources?.map((r) => r.id)).toEqual([otherLora.id, SFT_TURBO]);
  });
});
