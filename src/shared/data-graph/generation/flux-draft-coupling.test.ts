import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

const DRAFT = 699279;
const STANDARD = 691639;
const KREA = 2068000;

function init(workflow: string, modelId: number) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow,
      ecosystem: 'Flux1',
      model: { id: modelId, baseModel: 'Flux.1 D', model: { type: 'Checkpoint' } },
    },
    ext
  );
  return graph;
}

const state = (g: any) => g.getSnapshot() as { workflow: string; model?: { id: number } };

describe('flux draft build ⇄ draft workflow', () => {
  it('picking another flux version from the draft workflow moves to txt2img', () => {
    const g = init('txt2img:draft', DRAFT);
    g.set({ model: { id: KREA, model: { type: 'Checkpoint' } } });
    expect(state(g).workflow).toBe('txt2img');
    expect(state(g).model?.id).toBe(KREA);
  });

  it('picking the Draft version from txt2img moves to the draft workflow', () => {
    const g = init('txt2img', STANDARD);
    g.set({ model: { id: DRAFT, model: { type: 'Checkpoint' } } });
    expect(state(g).workflow).toBe('txt2img:draft');
  });

  it('loading the draft build on txt2img lands in the draft workflow, not on standard', () => {
    const g = init('txt2img', DRAFT);
    expect(state(g).workflow).toBe('txt2img:draft');
    expect(state(g).model?.id).toBe(DRAFT);
  });

  it('loading another build in the draft workflow puts it on the draft build', () => {
    const g = init('txt2img:draft', STANDARD);
    expect(state(g).workflow).toBe('txt2img:draft');
    expect(state(g).model?.id).toBe(DRAFT);
  });

  it('switching the workflow to draft puts flux on the draft build', () => {
    const g = init('txt2img', STANDARD);
    g.set({ workflow: 'txt2img:draft' });
    expect(state(g).model?.id).toBe(DRAFT);
  });
});
