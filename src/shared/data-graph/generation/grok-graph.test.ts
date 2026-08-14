import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import { grokVersionIds } from './version-ids';
import type { GenerationCtx } from './context';

const baseExt: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

const flagOn: GenerationCtx = { ...baseExt, flags: { grokImagine2: true } };

function init(workflow: string, modelId: number, ext: GenerationCtx = flagOn) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow,
      ecosystem: 'Grok',
      model: { id: modelId, baseModel: 'Grok', model: { type: 'Checkpoint' } },
    },
    ext
  );
  return graph;
}

const imagesMax = (g: any) => g.getSnapshot('images').meta.max;
const versionIds = (g: any) =>
  (g.getNodeMeta('model')?.versions?.options ?? []).map((o: any) => o.value);
const selectedModelId = (g: any) => g.getSnapshot().model?.id;

describe('grok image versions', () => {
  // `hasNode` is what `useGraphSubscription` checks; a missing node makes
  // `Controller` render null, which is how a control disappears from the form.
  it('exposes resolution and quality only on v2.0', () => {
    const v2 = init('txt2img', grokVersionIds['v2.0']);
    expect(v2.hasNode('resolution')).toBe(true);
    expect(v2.hasNode('quality')).toBe(true);

    const v1 = init('txt2img', grokVersionIds['v1.0']);
    expect(v1.hasNode('resolution')).toBe(false);
    expect(v1.hasNode('quality')).toBe(false);
  });

  it('caps edit source images at 3 on v2.0 and 7 on v1.0', () => {
    expect(imagesMax(init('img2img:edit', grokVersionIds['v2.0']))).toBe(3);
    expect(imagesMax(init('img2img:edit', grokVersionIds['v1.0']))).toBe(7);
  });

  it('re-evaluates the image cap when the version is switched in place', () => {
    const g = init('img2img:edit', grokVersionIds['v1.0']);
    expect(imagesMax(g)).toBe(7);
    g.set({ model: { id: grokVersionIds['v2.0'], model: { type: 'Checkpoint' } } });
    expect(imagesMax(g)).toBe(3);
  });
});

describe('grokImagine2 feature flag', () => {
  it('offers v2.0 in the version picker only when the flag is on', () => {
    expect(versionIds(init('txt2img', grokVersionIds['v1.0']))).toContain(grokVersionIds['v2.0']);

    const off = init('txt2img', grokVersionIds['v1.0'], baseExt);
    expect(versionIds(off)).toEqual([grokVersionIds['v1.0'], grokVersionIds['v1.5']]);
  });

  it('fails closed — an absent flags object hides v2.0', () => {
    const noFlags = init('txt2img', grokVersionIds['v1.0'], baseExt);
    expect(versionIds(noFlags)).not.toContain(grokVersionIds['v2.0']);
  });

  // Grok is `modelLocked`, so the model node clamps any id outside the version
  // options back to the ecosystem default. That is the server-side half of the
  // gate: a v2.0 id submitted with the flag off generates v1.0, it does not
  // reach the v2.0 handler branch.
  it('clamps a submitted v2.0 id back to v1.0 when the flag is off', () => {
    const off = init('txt2img', grokVersionIds['v2.0'], baseExt);
    expect(selectedModelId(off)).toBe(grokVersionIds['v1.0']);
    expect(off.hasNode('resolution')).toBe(false);

    const on = init('txt2img', grokVersionIds['v2.0']);
    expect(selectedModelId(on)).toBe(grokVersionIds['v2.0']);
  });
});
