import { describe, expect, it } from 'vitest';
import { generationGraph } from './generation-graph';
import { isOfficialKrea2Version, krea2VersionIds } from './krea2-graph';
import type { GenerationCtx } from './context';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 1 },
  user: { isMember: true, tier: 'gold' },
  gateRules: [],
};

const communityVersionId = 8888;

function init(workflow: string, modelId: number) {
  const graph = generationGraph as any;
  graph.init(
    {
      workflow,
      ecosystem: 'Krea2',
      model: { id: modelId, baseModel: 'Krea 2', model: { type: 'Checkpoint' } },
    },
    ext
  );
  return graph;
}

const selectedModelId = (g: any) => g.getSnapshot().model?.id;

describe('krea2 community checkpoints', () => {
  // Pins the unlock: with `modelLocked` on, common.ts's checkpoint clamp rewrote
  // every non-official id to the ecosystem default before the handler ever ran.
  it('lets a non-official checkpoint through on txt2img', () => {
    expect(selectedModelId(init('txt2img', communityVersionId))).toBe(communityVersionId);
  });

  it('gives it the comfy raw controls, not the FAL ones', () => {
    const g = init('txt2img', communityVersionId);
    expect(g.hasNode('cfgScale')).toBe(true);
    expect(g.hasNode('steps')).toBe(true);
    expect(g.hasNode('creativity')).toBe(false);
  });

  // An official build missing from krea2VersionIdToVariant reads as community, and
  // the handler sends it to the orchestrator as an override on the raw build.
  it.each(Object.entries(krea2VersionIds))('recognises official %s', (_name, id) => {
    expect(isOfficialKrea2Version(id)).toBe(true);
  });

  it('still gives the official size tiers the FAL controls', () => {
    const g = init('txt2img', krea2VersionIds.medium);
    expect(g.hasNode('creativity')).toBe(true);
    expect(g.hasNode('cfgScale')).toBe(false);
  });
});

describe('krea2 img2img:edit bases', () => {
  const cfgMax = (g: any) => g.getSnapshot('cfgScale').meta.max;
  const stepsMax = (g: any) => g.getSnapshot('steps').meta.max;

  it.each([
    ['turbo', krea2VersionIds.turbo, 2, 15],
    ['raw', krea2VersionIds.raw, 10, 60],
  ])('keeps the official %s base on its own control range', (_l, id, cfg, steps) => {
    const g = init('img2img:edit', id);
    expect(cfgMax(g)).toBe(cfg);
    expect(stepsMax(g)).toBe(steps);
  });

  // Turbo's ceilings sit below what an undistilled finetune needs, so landing a
  // community checkpoint there leaves the user no way to drive it.
  it('gives a community checkpoint the full-step range, not turbo ceilings', () => {
    const g = init('img2img:edit', communityVersionId);
    expect(selectedModelId(g)).toBe(communityVersionId);
    expect(cfgMax(g)).toBe(10);
    expect(stepsMax(g)).toBe(60);
  });
});
