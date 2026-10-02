import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { CUSTOM_ASPECT_RATIO } from '~/shared/constants/generation.constants';
import { MEGAPIXEL } from '~/utils/aspect-ratio-helpers';

/**
 * A custom width × height, parsed as the server parses a request. `validateInput`
 * runs the hub (served to users) and, until it is removed, the data-graph engine as
 * a shadow. The data-graph knows only the ~1 MP limits, so the two agree up to
 * 1536² and the ~4 MP tests below check the hub alone.
 */

const ctx: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

type Dims = { value: string; width: number; height: number };

function parseBoth(ecosystem: string, aspectRatio: unknown, extra: Record<string, unknown> = {}) {
  const input = { workflow: 'txt2img', ecosystem, prompt: 'a cat', aspectRatio, ...extra };
  const hub = generationHub.parse(input, ctx) as { success: boolean; data?: { aspectRatio: Dims } };
  const legacy = generationGraph.safeParse(input as never, ctx) as {
    success: boolean;
    data?: { aspectRatio: Dims };
  };
  expect(hub.success, 'hub parse').toBe(true);
  expect(legacy.success, 'data-graph parse').toBe(true);
  const pick = ({ value, width, height }: Dims) => ({ value, width, height });
  return { hub: pick(hub.data!.aspectRatio), legacy: pick(legacy.data!.aspectRatio) };
}

const custom = (width: number, height: number) => ({ value: CUSTOM_ASPECT_RATIO, width, height });

describe('custom aspect ratio', () => {
  it.each(['SDXL', 'Anima', 'Flux1', 'Flux2', 'ZImageTurbo', 'Chroma'])(
    'keeps an in-limits %s size exactly, in both engines',
    (ecosystem) => {
      const { hub, legacy } = parseBoth(ecosystem, custom(1024, 1536));
      expect(hub).toEqual(custom(1024, 1536));
      expect(legacy).toEqual(hub);
    }
  );

  it('snaps to /32 and fits an oversized request, in both engines', () => {
    const { hub, legacy } = parseBoth('SDXL', custom(1000, 1400));
    expect(hub).toEqual(custom(992, 1408));
    expect(legacy).toEqual(hub);

    const big = parseBoth('SDXL', custom(4000, 4000));
    expect(big.hub.width * big.hub.height).toBeLessThanOrEqual(1536 * 1536);
    expect(big.legacy).toEqual(big.hub);
  });

  // Three groups, by what each model's authors document. Only the hub is checked:
  // the data-graph engine is being removed and keeps the ~1 MP limits throughout.
  const hubOnly = (ecosystem: string, width: number, height: number) => {
    const r = generationHub.parse(
      { workflow: 'txt2img', ecosystem, prompt: 'a cat', aspectRatio: custom(width, height) },
      ctx
    ) as { success: boolean; data?: { aspectRatio: Dims } };
    expect(r.success).toBe(true);
    const { width: w, height: h } = r.data!.aspectRatio;
    return { width: w, height: h };
  };

  it.each(['Flux2', 'Ideogram', 'ZImageBase'])('lets ~4 MP %s have 2048 × 2048', (ecosystem) => {
    expect(hubOnly(ecosystem, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it.each(['SDXL', 'Illustrious', 'ZImageTurbo', 'Flux2Klein_9B', 'Anima', 'PonyV7', 'Flux1'])(
    'holds %s to 1536² (2.25 MP)',
    (ecosystem) => {
      const { width, height } = hubOnly(ecosystem, 2048, 2048);
      expect(width * height).toBeLessThanOrEqual(1536 * 1536);
    }
  );

  // The product ceiling: no image over 4 MP (2048²), whatever is asked for.
  it.each(['SDXL', 'Flux1', 'Flux2', 'Ideogram', 'ZImageBase', 'ZImageTurbo', 'SD1'])(
    'never lets %s past 4 MP',
    (ecosystem) => {
      for (const [w, h] of [
        [4000, 4000],
        [8000, 3000],
        [2048, 4096],
      ]) {
        const out = hubOnly(ecosystem, w!, h!);
        expect(out.width * out.height).toBeLessThanOrEqual(4 * MEGAPIXEL);
      }
    }
  );

  it('holds Flux.1 Pro to 1440 per side', () => {
    const { hub, legacy } = parseBoth('Flux1', custom(1536, 640), {
      model: { id: 922358, model: { type: 'Checkpoint' } },
    });
    expect(hub).toEqual(custom(1440, 640));
    expect(legacy).toEqual(hub);
  });

  it('holds SD1 to its own, smaller limits', () => {
    const { hub, legacy } = parseBoth('SD1', custom(1024, 1024));
    expect(hub.width * hub.height).toBeLessThanOrEqual(768 * 768);
    expect(legacy).toEqual(hub);
  });

  // Remix and legacy metadata send a source image's raw size with a ratio label;
  // only the explicit marker opts into custom, so those keep snapping to a bucket.
  it('still snaps a raw source size without the marker', () => {
    const { hub, legacy } = parseBoth('SDXL', { value: '4:3', width: 4000, height: 3000 });
    expect(hub).toEqual({ value: '4:3', width: 1152, height: 896 });
    expect(legacy).toEqual(hub);
  });

  it('snaps a custom value to a bucket on an ecosystem without custom limits', () => {
    const { hub, legacy } = parseBoth('Qwen', custom(1536, 640));
    expect(hub.value).not.toBe(CUSTOM_ASPECT_RATIO);
    expect(legacy).toEqual(hub);
  });

  it('a custom size survives the client store and validates', () => {
    const store = generationHub.createStore({ ext: ctx });
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });
    store.set({ aspectRatio: custom(1000, 1400) });

    const result = store.validate();
    expect(result.success).toBe(true);
    expect(store.getSnapshot().state.aspectRatio).toEqual(custom(992, 1408));
  });
});
