import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

function init(workflow: string) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow,
      ecosystem: 'WanVideo30',
      model: { id: 3267095, baseModel: 'Wan Video 3.0', model: { type: 'Checkpoint' } },
    },
    ext
  );
  return graph;
}

const ratios = (g: any) => (g.getNodeMeta('aspectRatio')?.options ?? []).map((o: any) => o.value);

/**
 * The set Alibaba documents for wan3.0-video, and the set the client's
 * `Wan30TextToVideoInput['aspectRatio']` union accepts. `getAspectRatioOptions`
 * drops any ratio missing from `aspectRatioDimensions` silently, so a ratio
 * disappearing from the picker produces no error anywhere.
 */
const EXPECTED = ['16:9', '4:3', '1:1', '3:4', '9:16'];

describe('wan 3.0 aspect ratio', () => {
  it('offers exactly the documented ratios at every resolution', () => {
    const g = init('txt2vid');
    for (const resolution of ['480p', '720p', '1080p']) {
      g.set({ resolution });
      expect(ratios(g), `at ${resolution}`).toEqual(EXPECTED);
    }
  });

  it('rescales dimensions with the resolution and keeps the selected ratio', () => {
    const g = init('txt2vid');

    g.set({ resolution: '480p' });
    expect(g.getSnapshot().aspectRatio).toMatchObject({ value: '16:9', width: 848, height: 480 });

    g.set({ resolution: '1080p' });
    expect(g.getSnapshot().aspectRatio).toMatchObject({ value: '16:9', width: 1920, height: 1080 });
  });

  it('hides the picker for image-to-video, which takes no aspectRatio', () => {
    const g = init('img2vid');
    g.set({ images: [{ url: 'https://example.test/a.png', width: 1024, height: 576 }] });
    expect(g.hasNode('aspectRatio')).toBe(false);
  });
});
