import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const DRAFT = 699279;
const STANDARD = 691639;

describe('flux draft coupling, interactive lane', () => {
  it('picking Draft from standard drags the workflow to txt2img:draft', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'x' });
    store.set({ model: { id: STANDARD, model: { type: 'Checkpoint' } } });
    expect((store.getField('model')?.value as { id: number }).id).toBe(STANDARD);

    store.set({ model: { id: DRAFT, model: { type: 'Checkpoint' } } });
    const s = store.getSnapshot().state as {
      workflow: string;
      model: { id: number };
      fluxMode: string;
    };
    console.log('after draft pick:', s.workflow, s.model?.id, s.fluxMode);
    expect(s.workflow).toBe('txt2img:draft');
    expect(s.model.id).toBe(DRAFT);
    expect(store.validate().success).toBe(true);
  });

  it('picking Standard while in draft drags the workflow back', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set({ workflow: 'txt2img:draft', ecosystem: 'Flux1', prompt: 'x' });
    expect((store.getField('model')?.value as { id: number }).id).toBe(DRAFT);

    store.set({ model: { id: STANDARD, model: { type: 'Checkpoint' } } });
    const s = store.getSnapshot().state as { workflow: string; model: { id: number } };
    console.log('after standard pick:', s.workflow, s.model?.id);
    expect(s.workflow).toBe('txt2img');
    expect(s.model.id).toBe(STANDARD);
    expect(store.validate().success).toBe(true);
  });

  it('the parse boundary still lets the workflow win (oracle parity)', () => {
    const result = generationHub.parse(
      { workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'x', model: DRAFT },
      EXT
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { workflow: string; model: { id: number } };
      expect(data.workflow).toBe('txt2img');
      expect(data.model.id).toBe(STANDARD);
    }
  });
});
