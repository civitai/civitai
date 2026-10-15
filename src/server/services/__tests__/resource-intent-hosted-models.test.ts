import { describe, expect, it } from 'vitest';

import { getRestrictedNsfwLevelsForBaseModel } from '~/server/common/constants';
import {
  HOSTED_MODELS_MAX,
  matchHostedModels,
} from '~/server/services/resource-intent-hosted-models';
import { ecosystemById, getBaseModelsByEcosystemId } from '~/shared/constants/basemodel.constants';
import {
  HOSTED_MODEL_CAPABILITIES,
  HOSTED_MODEL_CATALOG,
  hostedModelUrl,
  type HostedModelCatalogEntry,
} from '~/shared/constants/hosted-model-catalog.constants';

describe('hosted model catalog integrity', () => {
  it('pins the operator-approved entries, in ranking order', () => {
    expect(
      HOSTED_MODEL_CATALOG.map((e) => [ecosystemById.get(e.ecosystemId)?.key, e.modelId])
    ).toEqual([
      ['OpenAI', 1532032],
      ['NanoBanana', 1903424],
      ['Imagen4', 1669468],
      ['Seedream', 1951069],
      ['Grok', 2435474],
      ['MAI', 2673730],
      ['MuseImage', 2909814],
      ['Reve', 2781889],
      ['Ideogram', 2872974],
      ['Ming', 2961930],
      ['WanImage27', 2516180],
      ['Flux3', 2839203],
      ['Ernie', 2548387],
      ['Lens', 2655865],
      ['MageFlow', 2812690],
      ['HiDream-O1', 2618495],
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

  it('🔴 matureSupport is false exactly where a base model of the ecosystem restricts mature levels', () => {
    for (const e of HOSTED_MODEL_CATALOG) {
      const restricted = getBaseModelsByEcosystemId(e.ecosystemId).some(
        (bm) => getRestrictedNsfwLevelsForBaseModel(bm.name).length > 0
      );
      if (restricted) expect(e.matureSupport, e.name).toBe(false);
      if (e.matureSupport === false) expect(restricted, e.name).toBe(true);
    }
  });
});

const entry = (
  modelId: number,
  capabilities: HostedModelCatalogEntry['capabilities'],
  matureSupport: boolean | null = null,
  ecosystemId = HOSTED_MODEL_CATALOG[0].ecosystemId
): HostedModelCatalogEntry => ({
  ecosystemId,
  name: `m${modelId}`,
  maker: 'maker',
  modelId,
  goodAt: 'Good.',
  capabilities,
  matureSupport,
});

const ids = (r: { modelId: number }[]) => r.map((x) => x.modelId);
const SFW = { sfwOnly: true };
const MATURE = { sfwOnly: false };

describe('matchHostedModels', () => {
  it('ranks by distinct needs matched, then catalog order', () => {
    const catalog = [
      entry(1, ['legible_text']),
      entry(2, ['legible_text', 'photoreal']),
      entry(3, ['photoreal']),
      entry(4, ['legible_text', 'photoreal', 'image_editing']),
    ];
    expect(
      ids(matchHostedModels(['legible_text', 'photoreal', 'image_editing'], SFW, catalog))
    ).toEqual([4, 2, 1]);
    // A capability the caller did not ask for adds nothing: 2 and 4 tie, catalog order decides.
    expect(ids(matchHostedModels(['legible_text', 'photoreal'], SFW, catalog))).toEqual([2, 4, 1]);
    expect(ids(matchHostedModels(['photoreal'], SFW, catalog))).toEqual([2, 3, 4]);
  });

  it('a repeated need counts once', () => {
    const catalog = [entry(1, ['legible_text']), entry(2, ['photoreal', 'image_editing'])];
    expect(
      ids(
        matchHostedModels(
          ['legible_text', 'legible_text', 'photoreal', 'image_editing'],
          SFW,
          catalog
        )
      )
    ).toEqual([2, 1]);
  });

  it(`returns at most ${HOSTED_MODELS_MAX}`, () => {
    const catalog = [1, 2, 3, 4, 5].map((id) => entry(id, ['photoreal']));
    expect(ids(matchHostedModels(['photoreal'], SFW, catalog))).toEqual([1, 2, 3]);
  });

  it('returns nothing when nothing matches, or nothing is asked for', () => {
    const catalog = [entry(1, ['photoreal']), entry(2, [])];
    expect(matchHostedModels(['transparent_background'], SFW, catalog)).toEqual([]);
    expect(matchHostedModels([], SFW, catalog)).toEqual([]);
  });

  it('🔴 in mature mode only entries known to support mature content survive', () => {
    const catalog = [
      entry(1, ['photoreal'], null),
      entry(2, ['photoreal'], false),
      entry(3, ['photoreal'], true),
    ];
    expect(ids(matchHostedModels(['photoreal'], MATURE, catalog))).toEqual([3]);
    expect(ids(matchHostedModels(['photoreal'], SFW, catalog))).toEqual([1, 2, 3]);
  });

  it('projects the public item shape with the ecosystem key, not the id', () => {
    expect(matchHostedModels(['transparent_background'], SFW)).toEqual([
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
    expect(matchHostedModels(['character_consistency'], SFW)[1]).toMatchObject({
      key: 'HiDream-O1',
      modelId: 2618495,
    });
  });

  it('against the real catalog: mature mode returns only entries known to support it', () => {
    const supported = new Set(
      HOSTED_MODEL_CATALOG.filter((e) => e.matureSupport === true).map((e) => e.modelId)
    );
    for (const need of HOSTED_MODEL_CAPABILITIES) {
      for (const id of ids(matchHostedModels([need], MATURE))) expect(supported.has(id)).toBe(true);
    }
    // Ideogram (false) is eligible on a SFW ceiling.
    expect(ids(matchHostedModels(['legible_text', 'design_layout'], SFW))).toEqual([
      2673730, 2781889, 2872974,
    ]);
  });
});
