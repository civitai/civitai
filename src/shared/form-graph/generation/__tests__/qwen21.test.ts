import { describe, expect, it } from 'vitest';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import { getImagesLimit } from '~/shared/data-graph/generation/images-limit';
import { generationHub } from '../hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { qwen21AspectRatios } from '~/shared/constants/qwen21.constants';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};
const IMAGE = { url: 'https://example.com/reference.png', width: 896, height: 1152 };
const parse = (raw: Record<string, unknown>) => {
  const input = { ecosystem: 'Qwen21', prompt: 'A ceramic teapot', seed: 42, ...raw };
  const legacy = generationGraph.safeParse(input, EXT);
  const current = generationHub.parse(input, EXT);
  expect(legacy.success).toBe(true);
  expect(current.success).toBe(true);
  if (!legacy.success || !current.success) throw new Error('Qwen 2.1 did not validate');
  expect(current.data).toEqual(legacy.data);
  return current.data;
};

describe('Qwen Image 2.1 generator contract', () => {
  it('uses the unified model defaults without overwriting tuned settings', () => {
    expect(parse({ workflow: 'txt2img' })).toMatchObject({
      steps: 25,
      cfgScale: 1,
      resolution: '1K',
    });
    expect(parse({ workflow: 'txt2img', steps: 37, cfgScale: 2.5 })).toMatchObject({
      steps: 37,
      cfgScale: 2.5,
    });
  });

  it.each(Object.entries(qwen21AspectRatios))(
    'keeps every %s create preset within backend bounds',
    (resolution, ratios) => {
      for (const ratio of ratios) {
        const result = parse({ workflow: 'txt2img', resolution, aspectRatio: ratio.value });
        expect(result).toMatchObject({ aspectRatio: { width: ratio.width, height: ratio.height } });
        for (const dimension of [ratio.width, ratio.height]) {
          expect(dimension % 32).toBe(0);
          expect(dimension).toBeGreaterThanOrEqual(64);
          expect(dimension).toBeLessThanOrEqual(2048);
        }
      }
    }
  );

  it.each([1, 3, 10])(
    'preserves all %i editing references and excludes stale aspect ratios',
    (count) => {
      const images = Array.from({ length: count }, (_, index) => ({
        ...IMAGE,
        url: `https://example.com/${index}.png`,
      }));
      const result = parse({
        workflow: 'img2img:edit',
        images,
        aspectRatio: '16:9',
        resolution: '2K',
      });
      expect(result).toMatchObject({ images, resolution: '2K' });
      expect(result).not.toHaveProperty('aspectRatio');
    }
  );

  it('drops stale references from text-to-image requests', () => {
    expect(parse({ workflow: 'txt2img', images: [IMAGE] })).not.toHaveProperty('images');
  });

  it('limits only Qwen 2.1 to ten references', () => {
    expect(getImagesLimit('Qwen21', 'img2img:edit')).toEqual({ min: 1, max: 10 });
    for (const ecosystem of ['Qwen', 'Qwen2', 'Qwen3']) {
      expect(getImagesLimit(ecosystem, 'img2img:edit')).toEqual({ min: 1, max: 3 });
    }
  });

  it('keeps Qwen 2.1 LoRAs and filters adapters for the older weights', () => {
    const compatible = { id: 135, baseModel: 'Qwen 2.1', model: { type: 'LORA' }, strength: 0.6 };
    const old = { id: 136, baseModel: 'Qwen', model: { type: 'LORA' }, strength: 0.8 };
    expect(parse({ workflow: 'txt2img', resources: [compatible, old] })).toMatchObject({
      resources: [compatible],
    });
  });
});
