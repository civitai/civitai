import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import { grokVersionIds } from './version-ids';
import type { GenerationCtx } from './context';

const baseExt: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

const v2Hidden: GenerationCtx = {
  ...baseExt,
  gateRules: [
    {
      id: 'hide-grok-v2',
      name: '',
      availableTo: 'moderators',
      presentation: 'hidden',
      ecosystems: [],
      workflows: [],
      modelVersionIds: [grokVersionIds['v2.0']],
    },
  ],
};

function init(workflow: string, modelId: number, ext: GenerationCtx = baseExt) {
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

describe('grok v2.0 gate rule', () => {
  it('offers v2.0 unless a gate rule hides it', () => {
    expect(versionIds(init('txt2img', grokVersionIds['v1.0']))).toContain(grokVersionIds['v2.0']);

    const hidden = init('txt2img', grokVersionIds['v1.0'], v2Hidden);
    expect(versionIds(hidden)).toEqual([grokVersionIds['v1.0'], grokVersionIds['v1.5']]);
  });

  // gateRules reach the graph from getGenerationConfig AFTER init, unlike the
  // feature flags this gate replaced, which are right on the first render. The
  // model node captures its version list in a meta closure, so without an
  // `ext:gateRules` dep the hidden version stays in the picker for the session.
  it('applies a rule that arrives after init', () => {
    // its own ext object: `setExt` Object.assigns into the ext passed to `init`,
    // so sharing `baseExt` here would leave gateRules set for every later test
    const g = init('txt2img', grokVersionIds['v2.0'], { ...baseExt, gateRules: [] });
    expect(versionIds(g)).toContain(grokVersionIds['v2.0']);

    g.setExt({ gateRules: v2Hidden.gateRules });
    expect(versionIds(g)).not.toContain(grokVersionIds['v2.0']);
    expect(selectedModelId(g)).toBe(grokVersionIds['v1.0']);
  });

  // Grok is `modelLocked`, so a hidden id outside the version options is clamped
  // back to the ecosystem default — the server-side half of the gate.
  it('clamps a submitted v2.0 id back to v1.0 when hidden', () => {
    const hidden = init('txt2img', grokVersionIds['v2.0'], v2Hidden);
    expect(selectedModelId(hidden)).toBe(grokVersionIds['v1.0']);
    expect(hidden.hasNode('resolution')).toBe(false);

    const open = init('txt2img', grokVersionIds['v2.0']);
    expect(selectedModelId(open)).toBe(grokVersionIds['v2.0']);
  });
});
