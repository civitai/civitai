import { describe, expect, it } from 'vitest';

import {
  HOSTED_MODELS_MAX,
  matchHostedModels,
} from '~/server/services/resource-intent-hosted-models';
import { ecosystemById } from '~/shared/constants/basemodel.constants';
import {
  HOSTED_MODEL_CAPABILITIES,
  HOSTED_MODEL_CATALOG,
  hostedModelUrl,
  type HostedModelCatalogEntry,
} from '~/shared/constants/hosted-model-catalog.constants';

describe('hosted model catalog integrity', () => {
  it('pins the operator-approved entries in ranking order: key, model, capabilities', () => {
    expect(
      HOSTED_MODEL_CATALOG.map((e) => [
        ecosystemById.get(e.ecosystemId)?.key,
        e.modelId,
        e.capabilities,
      ])
    ).toEqual([
      ['OpenAI', 1532032, ['legible_text', 'image_editing']],
      ['NanoBanana', 1903424, ['character_consistency', 'image_editing']],
      ['Seedream', 1951069, ['high_resolution', 'legible_text']],
      ['Grok', 2435474, ['reference_images']],
      ['MAI', 2673730, ['photoreal', 'legible_text', 'image_editing']],
      ['MuseImage', 2909814, ['image_editing', 'reference_images']],
      ['Reve', 2781889, ['design_layout', 'high_resolution', 'legible_text']],
      ['Ideogram', 2872974, ['legible_text', 'design_layout', 'image_editing', 'reference_images']],
      ['Ming', 2961930, ['design_layout', 'legible_text', 'transparent_background']],
      ['WanImage27', 2516180, ['legible_text', 'design_layout', 'image_editing']],
      ['Flux3', 2839203, ['image_editing']],
      // No source claim for these two maps to a tag, so no `needs` can return them.
      ['Ernie', 2548387, []],
      ['Lens', 2655865, []],
      ['MageFlow', 2812690, ['image_editing', 'high_resolution']],
      [
        'HiDream-O1',
        2618495,
        ['image_editing', 'reference_images', 'character_consistency', 'high_resolution'],
      ],
    ]);
  });

  it('one entry per ecosystem and per model', () => {
    const ecosystemIds = HOSTED_MODEL_CATALOG.map((e) => e.ecosystemId);
    const modelIds = HOSTED_MODEL_CATALOG.map((e) => e.modelId);
    expect(new Set(ecosystemIds).size).toBe(ecosystemIds.length);
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it('every entry is well-formed', () => {
    const known = new Set<string>(HOSTED_MODEL_CAPABILITIES);
    for (const e of HOSTED_MODEL_CATALOG) {
      expect(Number.isInteger(e.modelId) && e.modelId > 0, String(e.modelId)).toBe(true);
      expect(hostedModelUrl(e.modelId)).toBe(`https://civitai.com/models/${e.modelId}`);
      expect(() => new URL(hostedModelUrl(e.modelId))).not.toThrow();
      expect(e.name.trim()).toBe(e.name);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.maker.length).toBeGreaterThan(0);
      expect(e.goodAt).toMatch(/^[A-Z].*\.$/);
      for (const c of e.capabilities) expect(known.has(c), `${e.name}: ${c}`).toBe(true);
      expect(new Set(e.capabilities).size, e.name).toBe(e.capabilities.length);
    }
  });
});

const entry = (
  modelId: number,
  capabilities: HostedModelCatalogEntry['capabilities'],
  ecosystemId = HOSTED_MODEL_CATALOG[0].ecosystemId
): HostedModelCatalogEntry => ({
  ecosystemId,
  name: `m${modelId}`,
  maker: 'maker',
  modelId,
  goodAt: 'Good.',
  capabilities,
});

const ids = (r: { modelId: number }[]) => r.map((x) => x.modelId);

describe('matchHostedModels', () => {
  it('ranks by distinct needs matched, then catalog order', () => {
    const catalog = [
      entry(1, ['legible_text']),
      entry(2, ['legible_text', 'photoreal']),
      entry(3, ['photoreal']),
      entry(4, ['legible_text', 'photoreal', 'image_editing']),
    ];
    expect(ids(matchHostedModels(['legible_text', 'photoreal', 'image_editing'], catalog))).toEqual(
      [4, 2, 1]
    );
    // A capability the caller did not ask for adds nothing: 2 and 4 tie, catalog order decides.
    expect(ids(matchHostedModels(['legible_text', 'photoreal'], catalog))).toEqual([2, 4, 1]);
    expect(ids(matchHostedModels(['photoreal'], catalog))).toEqual([2, 3, 4]);
  });

  it('a repeated need counts once', () => {
    const catalog = [entry(1, ['legible_text']), entry(2, ['photoreal', 'image_editing'])];
    expect(
      ids(
        matchHostedModels(['legible_text', 'legible_text', 'photoreal', 'image_editing'], catalog)
      )
    ).toEqual([2, 1]);
  });

  it(`returns at most ${HOSTED_MODELS_MAX}`, () => {
    const catalog = [1, 2, 3, 4, 5].map((id) => entry(id, ['photoreal']));
    expect(ids(matchHostedModels(['photoreal'], catalog))).toEqual([1, 2, 3]);
  });

  it('returns nothing when nothing matches, or nothing is asked for', () => {
    const catalog = [entry(1, ['photoreal']), entry(2, [])];
    expect(matchHostedModels(['transparent_background'], catalog)).toEqual([]);
    expect(matchHostedModels([], catalog)).toEqual([]);
  });

  it('projects the public item shape with the ecosystem key, not the id', () => {
    expect(matchHostedModels(['transparent_background'])).toEqual([
      {
        key: 'Ming',
        name: 'Ming Image Design',
        maker: 'inclusionAI',
        modelId: 2961930,
        url: 'https://civitai.com/models/2961930',
        goodAt:
          'UI mockups, infographics, posters and slides with legible type, including RGBA output on a transparent background.',
        capabilities: ['design_layout', 'legible_text', 'transparent_background'],
      },
    ]);
    expect(matchHostedModels(['character_consistency'])[1]).toMatchObject({
      key: 'HiDream-O1',
      modelId: 2618495,
    });
  });

  it('against the real catalog: ranks by both needs, then catalog order', () => {
    expect(ids(matchHostedModels(['legible_text', 'design_layout']))).toEqual([
      2781889, 2872974, 2961930,
    ]);
  });
});
