import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { CUSTOM_ASPECT_RATIO } from '~/shared/constants/generation.constants';
import { MEGAPIXEL } from '~/utils/aspect-ratio-helpers';
import { krea2VersionIds } from '~/shared/form-graph/generation/image/krea2.graph';

/**
 * A custom width × height, parsed as the server parses a request — `validateInput` runs the
 * hub, which is now the only engine.
 *
 * Written on main as a differential against the data-graph engine, which agreed up to 1536².
 * That oracle is deleted with the lane, and a differential has no meaning with one engine, so
 * the assertions below are the absolute half: each one states the dimensions the hub must
 * produce rather than comparing two parsers.
 */

const ctx: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

type Dims = { value: string; width: number; height: number };

function parseHub(ecosystem: string, aspectRatio: unknown, extra: Record<string, unknown> = {}) {
  const input = { workflow: 'txt2img', ecosystem, prompt: 'a cat', aspectRatio, ...extra };
  const hub = generationHub.parse(input, ctx) as { success: boolean; data?: { aspectRatio: Dims } };
  expect(hub.success, 'hub parse').toBe(true);
  const { value, width, height } = hub.data!.aspectRatio;
  return { value, width, height };
}

const custom = (width: number, height: number) => ({ value: CUSTOM_ASPECT_RATIO, width, height });

describe('custom aspect ratio', () => {
  it.each(['SDXL', 'Anima', 'Flux1', 'Flux2', 'ZImageTurbo', 'Chroma'])(
    'keeps an in-limits %s size exactly, in both engines',
    (ecosystem) => {
      const hub = parseHub(ecosystem, custom(1024, 1536));
      expect(hub).toEqual(custom(1024, 1536));
    }
  );

  it('snaps to /32 and fits an oversized request, in both engines', () => {
    const hub = parseHub('SDXL', custom(1000, 1400));
    expect(hub).toEqual(custom(992, 1408));

    const big = parseHub('SDXL', custom(4000, 4000));
    expect(big.width * big.height).toBeLessThanOrEqual(1536 * 1536);
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
    const hub = parseHub('Flux1', custom(1536, 640), {
      model: { id: 922358, model: { type: 'Checkpoint' } },
    });
    // Shrunk whole, not just clamped: 1536 × 640 keeps its 2.4:1 as 1440 × 608.
    expect(hub).toEqual(custom(1440, 608));
  });

  it('holds SD1 to its own, smaller limits', () => {
    const hub = parseHub('SD1', custom(1024, 1024));
    expect(hub.width * hub.height).toBeLessThanOrEqual(768 * 768);
  });

  // Remix and legacy metadata send a source image's raw size with a ratio label;
  // only the explicit marker opts into custom, so those keep snapping to a bucket.
  it('still snaps a raw source size without the marker', () => {
    const hub = parseHub('SDXL', { value: '4:3', width: 4000, height: 3000 });
    expect(hub).toEqual({ value: '4:3', width: 1152, height: 896 });
  });

  it('snaps a custom value to a bucket on an ecosystem without custom limits', () => {
    const hub = parseHub('Qwen', custom(1536, 640));
    expect(hub.value).not.toBe(CUSTOM_ASPECT_RATIO);
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

describe('Krea 2', () => {
  const krea2 = (versionId: number, extra: Record<string, unknown>) => {
    const r = generationHub.parse(
      {
        workflow: 'txt2img',
        ecosystem: 'Krea2',
        prompt: 'a cat',
        model: { id: versionId, model: { type: 'Checkpoint' } },
        ...extra,
      },
      ctx
    ) as { success: boolean; data?: { aspectRatio: Dims } };
    expect(r.success).toBe(true);
    return r.data!.aspectRatio;
  };

  // The 2K tier doubled each bucket: 16:9 went out as 2752 × 1536, which the comfy
  // input (64–2048 per side) refused. Every 2K size now fits and keeps its ratio.
  it.each(['16:9', '4:3', '3:2', '1:1', '4:5', '2:3', '9:16'])(
    'sends 2K %s inside 2048 per side and 4 MP, at that ratio',
    (ratio) => {
      const { width, height } = krea2(krea2VersionIds.raw, {
        resolution: '2K',
        aspectRatio: ratio,
      });
      expect(Math.max(width, height)).toBeLessThanOrEqual(2048);
      expect(width * height).toBeLessThanOrEqual(4 * MEGAPIXEL);
      const [a, b] = ratio.split(':').map(Number) as [number, number];
      expect(Math.abs(width / height - a / b) / (a / b)).toBeLessThan(0.03);
    }
  );

  it('takes a custom size on the comfy builds', () => {
    expect(krea2(krea2VersionIds.raw, { aspectRatio: custom(2048, 1152) })).toEqual(
      custom(2048, 1152)
    );
  });

  // The FAL tiers take a ratio label only: a custom size snaps to the nearest one.
  it('snaps a custom size to a ratio on the FAL tiers', () => {
    expect(krea2(krea2VersionIds.medium, { aspectRatio: custom(2048, 1152) }).value).toBe('16:9');
  });
});
