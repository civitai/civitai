import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { getEcosystemField } from '~/shared/form-graph/generation/ecosystem-gates';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GateRule } from '~/shared/generation/gates';
import { repickUnavailableEcosystem } from '../ecosystem-repick';
import { applyGenerationData } from '../ingestion';

/**
 * Gate rules arrive after the store is built (`getGenerationConfig` is a client
 * query), so every case starts ungated and calls `setExt` with the rule, which is
 * what `useForm` does when the config lands.
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
  const store = generationHub.createStore({
    ext: EXT,
    storage: stored ? { load: () => stored, save: () => undefined } : undefined,
  });
  const stop = repickUnavailableEcosystem(store);
  const ecosystem = () => (store.getSnapshot().state as { ecosystem?: string }).ecosystem;
  return { store, stop, ecosystem };
}

describe('re-picking an ecosystem that became unavailable', () => {
  it('moves the default off a disabled ecosystem', () => {
    const { store, ecosystem } = setup();
    expect(ecosystem()).toBe('ZImageTurbo');
    store.setExt(disabledFor(['ZImageTurbo']));
    // The first usable txt2img ecosystem in workflow order.
    expect(ecosystem()).toBe('SD1');
  });

  it('keeps an available choice the user made', () => {
    const { store, ecosystem } = setup();
    store.set({ ecosystem: 'Flux1' });
    store.setExt(disabledFor(['ZImageTurbo']));
    expect(ecosystem()).toBe('Flux1');
  });

  it('keeps an available stored choice', () => {
    const { store, ecosystem } = setup({ workflow: 'txt2img', 'ecosystem@image': 'Flux1' });
    store.setExt(disabledFor(['ZImageTurbo']));
    expect(ecosystem()).toBe('Flux1');
  });

  it('keeps an available remixed ecosystem', () => {
    const { store, ecosystem } = setup();
    store.setExt(disabledFor(['ZImageTurbo']));
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'txt2img', ecosystem: 'Illustrious', prompt: 'a cat' },
      resources: [],
    });
    expect(ecosystem()).toBe('Illustrious');
  });

  it('replaces an unavailable choice with the default', () => {
    const { store, ecosystem } = setup();
    store.set({ ecosystem: 'Flux1' });
    store.setExt(disabledFor(['Flux1']));
    expect(ecosystem()).toBe('ZImageTurbo');
  });

  it('replaces an unavailable stored choice, skipping a disabled default too', () => {
    const { store, ecosystem } = setup({ workflow: 'txt2img', 'ecosystem@image': 'Flux1' });
    expect(ecosystem()).toBe('Flux1');
    store.setExt(disabledFor(['Flux1', 'ZImageTurbo']));
    expect(ecosystem()).toBe('SD1');
  });

  it('replaces an unavailable remixed ecosystem', () => {
    const { store, ecosystem } = setup();
    store.setExt(disabledFor(['Illustrious']));
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'txt2img', ecosystem: 'Illustrious', prompt: 'a cat' },
      resources: [],
    });
    expect(ecosystem()).toBe('ZImageTurbo');
  });

  it('leaves the state alone when nothing is available', () => {
    const everything = getEcosystemField('txt2img', EXT, {
      preferred: 'ZImageTurbo',
    }).compatibleEcosystems;
    expect(everything).toContain('Flux1');
    const { store, ecosystem } = setup();
    store.set({ ecosystem: 'Flux1' });
    store.setExt(disabledFor(everything));
    expect(ecosystem()).toBe('Flux1');
    expect(store.getIntent()).toMatchObject({ 'ecosystem@image': 'Flux1' });
  });

  it('stops re-picking once unsubscribed', () => {
    const { store, stop, ecosystem } = setup();
    store.set({ ecosystem: 'Flux1' });
    stop();
    store.setExt(disabledFor(['Flux1']));
    expect(ecosystem()).toBe('Flux1');
  });
});
