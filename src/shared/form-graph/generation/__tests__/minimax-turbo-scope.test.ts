import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

describe('minimax steps scoped per turbo mode', () => {
  it('toggle applies the mode default; each mode remembers its own value', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2vid', ecosystem: 'MiniMaxH3', prompt: 'x' });

    expect(store.getField('steps')?.value).toBe(30);

    store.set({ turbo: true });
    const on = store.getField('steps');
    console.log('turbo on :', JSON.stringify({ v: on?.value, meta: on?.meta }));
    expect(on?.value).toBe(8);

    store.set({ steps: 15 });
    store.set({ turbo: false });
    const off = store.getField('steps');
    console.log('turbo off:', JSON.stringify({ v: off?.value, meta: off?.meta }));
    expect(off?.value).toBe(30);

    store.set({ turbo: true });
    expect(store.getField('steps')?.value).toBe(15);

    expect(store.validate().success).toBe(true);
  });
});
