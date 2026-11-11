import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { model3dGenerator: true },
  gateRules: [],
};

const storeOn = (workflow: string) => {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'Tripo' });
  return store;
};

describe('Tripo versions', () => {
  it('text-to-3D runs on H3.1 even when v2.5 was picked', () => {
    const store = storeOn('txt2model3d');
    store.set({ version: 'v2.5', prompt: 'a treasure chest' });

    const result = store.validate();
    expect(result.success).toBe(true);
    expect((result as { data?: { version?: string } }).data?.version).toBe('h3.1');
    expect(store.getField('images')).toBeNull();
  });

  it('H3.1 takes up to four views; v2.5 one, truncating on the switch', () => {
    const store = storeOn('img2model3d');
    store.set({ version: 'h3.1' });
    expect((store.getField('images')?.meta as { max?: number })?.max).toBe(4);

    const views = ['a', 'b', 'c'].map((v) => ({
      url: `https://x/${v}.png`,
      width: 512,
      height: 512,
    }));
    store.set({ images: views });
    store.set({ version: 'v2.5' });

    expect(store.getField('images')?.value).toHaveLength(1);
    expect(store.getField('geometryQuality')).toBeNull();
  });

  // `faceLimit` defaults to `undefined` ("Auto"), so the unset value reaches its `correct`
  // hook — which must leave it unset rather than treat it as out of range and send the minimum.
  it('an unset face limit stays Auto, not the minimum', () => {
    const store = storeOn('txt2model3d');
    store.set({ prompt: 'a treasure chest' });

    expect(store.getField('faceLimit')?.value).toBeUndefined();
    const result = store.validate() as { success: boolean; data?: { faceLimit?: number } };
    expect(result.success).toBe(true);
    expect(result.data?.faceLimit).toBeUndefined();
  });

  it('a face limit outside the range still clamps into it', () => {
    const store = storeOn('txt2model3d');
    store.set({ prompt: 'a treasure chest', faceLimit: 10 });

    const result = store.validate() as { success: boolean; data?: { faceLimit?: number } };
    expect(result.success).toBe(true);
    expect(result.data?.faceLimit).toBe(1000);
  });

  it('drops a seed above the signed 32-bit range Tripo accepts', () => {
    const store = storeOn('txt2model3d');
    store.set({ prompt: 'a treasure chest', seed: 3_000_000_000, textureSeed: 42 });

    const result = store.validate() as {
      success: boolean;
      data?: { seed?: number; textureSeed?: number };
    };
    expect(result.success).toBe(true);
    expect(result.data?.seed).toBeUndefined();
    expect(result.data?.textureSeed).toBe(42);
  });

  it('a blank face limit goes out unset so Tripo picks the count, not the 1000 minimum', () => {
    const faceLimitFor = (faceLimit?: unknown) => {
      const store = storeOn('txt2model3d');
      store.set({
        prompt: 'a treasure chest',
        ...(faceLimit !== undefined && { faceLimit }),
      } as never);
      const result = store.validate() as { success: boolean; data?: { faceLimit?: number } };
      expect(result.success).toBe(true);
      return result.data?.faceLimit;
    };

    expect(faceLimitFor()).toBeUndefined();
    // a stored or remixed blank
    expect(faceLimitFor(null)).toBeUndefined();
    expect(faceLimitFor('')).toBeUndefined();
    expect(faceLimitFor(30_000)).toBe(30_000);
    expect(faceLimitFor(500)).toBe(1_000);
    expect(faceLimitFor(5_000_000)).toBe(2_000_000);
  });
});
