import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GateRuleView } from '~/shared/generation/gates';

/** A changed config reaches the store as a new `ext`; the user's picks and entries must survive it. */
const sdxlGate = {
  availableTo: 'moderators',
  presentation: 'hidden',
  ecosystems: ['SDXL'],
  workflows: [],
  modelVersionIds: [],
} satisfies GateRuleView;

const ctx = (gateRules: GateRuleView[]): GenerationCtx => ({
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules,
});

describe('generator config refresh', () => {
  it('keeps the picked ecosystem and entered values as its gate comes and goes', () => {
    const userInput = { ecosystem: 'SDXL', prompt: 'a red fox in the snow', quantity: 3 };
    const store = generationHub.createStore({ ext: ctx([]) });
    store.set(userInput);
    const state = () => store.getSnapshot().state as Record<string, unknown>;

    store.setExt(ctx([sdxlGate]));
    expect(state()).toMatchObject(userInput);

    store.setExt(ctx([]));
    expect(state()).toMatchObject(userInput);
  });
});
