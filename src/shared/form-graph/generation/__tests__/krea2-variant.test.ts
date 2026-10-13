import { describe, expect, it } from 'vitest';
import { ecosystemKeyForBaseModel } from '~/shared/form-graph/generation/checkpoint';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import {
  KREA2_TURBO_BASE_MODEL,
  krea2VersionIds,
} from '~/shared/form-graph/generation/image/krea2.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

const communityVersionId = 8888;

function state(workflow: string, model: { id: number; baseModel?: string }) {
  const s = generationHub.createStore({ ext: EXT });
  s.set({ workflow, ecosystem: 'Krea2', prompt: 'a cat' });
  s.set({ model: { ...model, model: { type: 'Checkpoint' } } });
  return s.getSnapshot().state as Record<string, unknown>;
}

describe('krea2 variant', () => {
  it('names a registered Krea 2 base model', () => {
    expect(ecosystemKeyForBaseModel(KREA2_TURBO_BASE_MODEL)).toBe('Krea2');
  });

  it('gives a Turbo fine-tune the turbo build and its defaults', () => {
    const s = state('txt2img', { id: communityVersionId, baseModel: KREA2_TURBO_BASE_MODEL });

    expect(s.krea2Variant).toBe('turbo');
    expect(s.steps).toBe(8);
    expect(s.cfgScale).toBe(1);
  });

  it('keeps an untagged community checkpoint on the raw build', () => {
    const s = state('txt2img', { id: communityVersionId, baseModel: 'Krea 2' });

    expect(s.krea2Variant).toBe('raw');
    expect(s.steps).toBe(30);
    expect(s.cfgScale).toBe(3.5);
  });

  it('edits the official Turbo version on editTurbo by its id alone', () => {
    const s = state('img2img:edit', { id: krea2VersionIds.turbo });

    expect(s.krea2Variant).toBe('editTurbo');
    expect(s.steps).toBe(8);
    expect(s.cfgScale).toBe(1);
  });

  it.each([
    ['large', krea2VersionIds.large, 'fal'],
    ['raw', krea2VersionIds.raw, 'raw'],
  ])('keeps the official %s version on its own branch despite a Turbo tag', (_l, id, variant) => {
    expect(state('txt2img', { id, baseModel: KREA2_TURBO_BASE_MODEL }).krea2Variant).toBe(variant);
  });

  it.each([
    [KREA2_TURBO_BASE_MODEL, 'editTurbo'],
    ['Krea 2', 'editRaw'],
  ])('edits a %s community checkpoint on %s', (baseModel, variant) => {
    expect(state('img2img:edit', { id: communityVersionId, baseModel }).krea2Variant).toBe(variant);
  });
});
