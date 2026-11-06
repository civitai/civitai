import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { getEcosystemField } from '~/shared/form-graph/generation/ecosystem-gates';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GateRule } from '~/shared/generation/gates';
import { correctUnavailableEcosystem, preservingStorage } from '../ecosystem-repick';
import { applyGenerationData } from '../ingestion';

/**
 * Gate rules arrive after the store is built (`getGenerationConfig` is a client
 * query). Each case starts ungated, calls `setExt` with the rule (what `useForm`
 * does when the config lands) and then runs the one-shot correction, which is
 * what `BaseGenerationForm` does next. `disk` is the persistence layer.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
};

const disabledFor = (ecosystems: string[]): GenerationCtx => ({
  ...EXT,
  gateRules: [
    {
      id: 'test-rule',
      name: '',
      availableTo: 'moderators',
      presentation: 'disabled',
      message: null,
      ecosystems,
      workflows: [],
      modelVersionIds: [],
    } satisfies GateRule,
  ],
});

function setup(stored?: Record<string, unknown>) {
  const disk: { record: Record<string, unknown> | undefined } = {
    record: stored && { ...stored },
  };
  const storage = preservingStorage({
    load: () => disk.record && { ...disk.record },
    save: (intent) => void (disk.record = { ...intent }),
  });
  if (!storage) throw new Error('preservingStorage returned nothing for a real adapter');
  const store = generationHub.createStore({ ext: EXT, storage });
  const ecosystem = () => (store.getSnapshot().state as { ecosystem?: string }).ecosystem;
  const load = (ext: GenerationCtx) => {
    store.setExt(ext);
    return correctUnavailableEcosystem(store, storage);
  };
  return { store, disk, ecosystem, load };
}

const STORED_FLUX = { workflow: 'txt2img', 'ecosystem@image': 'Flux1' };

describe('correcting an unavailable ecosystem when the gates load', () => {
  it('corrects a stored disabled ecosystem in memory', () => {
    const { ecosystem, load } = setup(STORED_FLUX);
    expect(ecosystem()).toBe('Flux1');
    load(disabledFor(['Flux1']));
    expect(ecosystem()).toBe('ZImageTurbo');
  });

  it('leaves the persisted choice unchanged, across later saves', () => {
    const { store, disk, load } = setup(STORED_FLUX);
    load(disabledFor(['Flux1']));
    expect(disk.record?.['ecosystem@image']).toBe('Flux1');
    store.set({ prompt: 'a cat' });
    expect(disk.record?.prompt).toBe('a cat');
    expect(disk.record?.['ecosystem@image']).toBe('Flux1');
  });

  it('returns to the stored choice once the gate lifts', () => {
    const first = setup(STORED_FLUX);
    first.load(disabledFor(['Flux1']));
    const next = setup(first.disk.record);
    next.load(EXT);
    expect(next.ecosystem()).toBe('Flux1');
  });

  it('skips a disabled default too, landing on the first usable ecosystem', () => {
    const { ecosystem, disk, load } = setup(STORED_FLUX);
    load(disabledFor(['Flux1', 'ZImageTurbo']));
    expect(ecosystem()).toBe('SD1');
    expect(disk.record?.['ecosystem@image']).toBe('Flux1');
  });

  it('corrects a disabled ecosystem remixed in before the gates loaded', () => {
    const { store, disk, ecosystem, load } = setup();
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'txt2img', ecosystem: 'Illustrious', prompt: 'a cat' },
      resources: [],
    });
    load(disabledFor(['Illustrious']));
    expect(ecosystem()).toBe('ZImageTurbo');
    expect(disk.record?.['ecosystem@image']).toBe('Illustrious');
  });

  it('a fresh session falls off a disabled default and saves no ecosystem', () => {
    const { ecosystem, disk, load } = setup();
    load(disabledFor(['ZImageTurbo']));
    expect(ecosystem()).toBe('SD1');
    expect(Object.keys(disk.record ?? {}).filter((k) => k.startsWith('ecosystem'))).toEqual([]);
  });

  it('leaves an available stored choice alone', () => {
    const { ecosystem, disk, load } = setup(STORED_FLUX);
    expect(load(disabledFor(['ZImageTurbo']))).toBe(false);
    expect(ecosystem()).toBe('Flux1');
    expect(disk.record?.['ecosystem@image']).toBe('Flux1');
  });

  it('leaves the state alone when nothing is available', () => {
    const everything = getEcosystemField('txt2img', EXT, {
      preferred: 'ZImageTurbo',
    }).compatibleEcosystems;
    expect(everything).toContain('Flux1');
    const { store, ecosystem, disk, load } = setup(STORED_FLUX);
    expect(load(disabledFor(everything))).toBe(false);
    expect(ecosystem()).toBe('Flux1');
    expect(store.getIntent()).toMatchObject({ 'ecosystem@image': 'Flux1' });
    expect(disk.record?.['ecosystem@image']).toBe('Flux1');
  });
});

describe('after the gates loaded', () => {
  it('a pick of a disabled ecosystem stays selected, so the form can explain it', () => {
    const { store, ecosystem, load } = setup();
    load(disabledFor(['Flux1']));
    store.set({ ecosystem: 'Flux1' });
    expect(ecosystem()).toBe('Flux1');
  });

  it('a disabled remix stays selected', () => {
    const { store, ecosystem, load } = setup();
    load(disabledFor(['Illustrious']));
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'txt2img', ecosystem: 'Illustrious', prompt: 'a cat' },
      resources: [],
    });
    expect(ecosystem()).toBe('Illustrious');
  });

  it("saves the user's own next pick over the preserved one", () => {
    const { store, disk, load } = setup(STORED_FLUX);
    load(disabledFor(['Flux1']));
    store.set({ ecosystem: 'Illustrious' });
    expect(disk.record?.['ecosystem@image']).toBe('Illustrious');
  });
});
