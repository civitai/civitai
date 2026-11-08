import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * The generator config now refetches while the form is open, and a changed config reaches the
 * store as a new `ext`. What the user has already entered must survive that.
 */
const wanGate = {
  availableTo: 'moderators',
  presentation: 'hidden',
  ecosystems: ['WanVideo22'],
  workflows: [],
  modelVersionIds: [],
} satisfies GenerationCtx['gateRules'][number];

const ctx = (gateRules: GenerationCtx['gateRules']): GenerationCtx => ({
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules,
});

const userInput = { prompt: 'a red fox in the snow', quantity: 3, steps: 12 };

function storeWithInput(gateRules: GenerationCtx['gateRules']) {
  const store = generationHub.createStore({ ext: ctx(gateRules) });
  store.set(userInput);
  return store;
}

const state = (store: ReturnType<typeof storeWithInput>) =>
  store.getSnapshot().state as Record<string, unknown>;

describe('generator config refresh', () => {
  it('keeps entered values when a refetch returns the same config', () => {
    const store = storeWithInput([wanGate]);
    store.setExt(ctx([{ ...wanGate }]));
    expect(state(store)).toMatchObject(userInput);
  });

  it('keeps entered values when a gate is lifted', () => {
    const store = storeWithInput([wanGate]);
    store.setExt(ctx([]));
    expect(state(store)).toMatchObject(userInput);
  });

  it('keeps entered values when an unrelated gate is added', () => {
    const store = storeWithInput([]);
    store.setExt(ctx([wanGate]));
    expect(state(store)).toMatchObject(userInput);
  });

  it('would notice a lost value (control: reset clears them)', () => {
    const store = storeWithInput([]);
    store.reset();
    expect(state(store)).not.toMatchObject(userInput);
  });
});
