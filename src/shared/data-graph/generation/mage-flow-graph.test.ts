import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import { mageFlowVersionIds } from './mage-flow-graph';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

function initGraph(workflow: string, modelId?: number) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow,
      ecosystem: 'MageFlow',
      ...(modelId
        ? { model: { id: modelId, baseModel: 'MageFlow', model: { type: 'Checkpoint' } } }
        : {}),
    },
    ext
  );
  return graph;
}

function modelOptionValues(graph: any) {
  const meta = graph.getSnapshot('model').meta;
  const opts = meta?.versions?.options ?? meta?.options ?? [];
  return opts.map((o: any) => o.value);
}

describe('mageFlowGraph', () => {
  it('offers the text-to-image checkpoints on txt2img', () => {
    expect(modelOptionValues(initGraph('txt2img'))).toEqual([
      mageFlowVersionIds.txt2img_standard,
      mageFlowVersionIds.txt2img_turbo,
    ]);
  });

  it('offers the edit checkpoints on img2img:edit', () => {
    expect(modelOptionValues(initGraph('img2img:edit'))).toEqual([
      mageFlowVersionIds.edit_standard,
      mageFlowVersionIds.edit_turbo,
    ]);
  });

  it('defaults to the standard build for each workflow', () => {
    expect(initGraph('txt2img').getSnapshot('model').value?.id).toBe(
      mageFlowVersionIds.txt2img_standard
    );
    expect(initGraph('img2img:edit').getSnapshot('model').value?.id).toBe(
      mageFlowVersionIds.edit_standard
    );
  });

  it('moves off a text-to-image checkpoint when switching to edit', () => {
    const graph = initGraph('txt2img', mageFlowVersionIds.txt2img_turbo);
    graph.set({ workflow: 'img2img:edit' });
    // Matches Qwen: the target workflow's default wins rather than the
    // index-equivalent variant. What matters is that a t2i checkpoint can never
    // survive into an edit workflow.
    expect(graph.getSnapshot('model').value?.id).toBe(mageFlowVersionIds.edit_standard);
  });

  it('applies turbo slider ranges only for turbo versions', () => {
    const standard = initGraph('txt2img', mageFlowVersionIds.txt2img_standard);
    expect(standard.getSnapshot('steps').meta).toMatchObject({ max: 50 });
    expect(standard.getSnapshot('cfgScale').meta).toMatchObject({ max: 10 });

    const turbo = initGraph('txt2img', mageFlowVersionIds.txt2img_turbo);
    expect(turbo.getSnapshot('steps').meta).toMatchObject({ max: 12 });
    expect(turbo.getSnapshot('cfgScale').meta).toMatchObject({ max: 2 });
  });
});
