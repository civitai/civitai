import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import { minimaxVersionIds } from './minimax-graph';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

function init(
  workflow: string,
  modelId: number,
  images?: { url: string; width: number; height: number }[]
) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow,
      ecosystem: 'MiniMaxH3',
      model: { id: modelId, baseModel: 'MiniMax H3', model: { type: 'Checkpoint' } },
      ...(images ? { images } : {}),
    },
    ext
  );
  return graph;
}

const frame = [{ url: 'https://example.test/first-frame.jpeg', width: 1280, height: 720 }];

// The shared prompt rule treats an attached image as excusing the prompt, which
// is right for image models and wrong here: H3 rejects a text-less request on
// every workflow (`content[0].text is empty for type=text`, 2013). A revert of
// that reads as `expected false to be true` on the image-bearing workflows.
describe('minimax prompt requirement', () => {
  it.each([
    ['txt2vid', undefined],
    ['img2vid', frame],
    ['img2vid:first-last', frame],
    ['img2vid:ref2vid', frame],
  ])('requires a prompt on %s', (workflow, images) => {
    const graph = init(workflow, minimaxVersionIds['v1.0'], images);
    expect(graph.getSnapshot('prompt').meta.required).toBe(true);
  });

  it('requires it on the comfy variant too', () => {
    const graph = init('img2vid', minimaxVersionIds.comfy, frame);
    expect(graph.getSnapshot('prompt').meta.required).toBe(true);
  });

  it('fails validation on the prompt when it is empty despite an attached frame', () => {
    const graph = init('img2vid', minimaxVersionIds['v1.0'], frame);
    graph.set({ prompt: '' });
    const result = graph.validate();
    expect(result.success).toBe(false);
    // Naming the key matters: a fixture missing an unrelated field also fails
    // validation, which would make this pass while proving nothing.
    expect(Object.keys(result.errors)).toEqual(['prompt']);
  });

  it('passes once a prompt is present', () => {
    const graph = init('img2vid', minimaxVersionIds['v1.0'], frame);
    graph.set({ prompt: 'a slow dolly through a neon arcade' });
    expect(graph.validate().success).toBe(true);
  });
});
