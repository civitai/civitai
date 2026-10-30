import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const ext = (flags: GenerationCtx['flags']): GenerationCtx => ({
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { model3dGenerator: true, ...flags },
  gateRules: [],
});

const image = (n: number) => ({ url: `https://x/${n}.png`, width: 1024, height: 1024 });

function submitTripo(flags: GenerationCtx['flags'], values: Record<string, unknown>) {
  const store = generationHub.createStore({ ext: ext(flags) });
  store.set({ workflow: 'img2model3d', ecosystem: 'Tripo', ...values });
  return store.validate() as { success: boolean; data?: Record<string, unknown> };
}

describe('Tripo version gate', () => {
  // A crafted submit carries tripoVersion directly; the field's clamp is the gate.
  it('runs a submitted H3.1 as v2.5 without the flag', () => {
    const result = submitTripo({}, { tripoVersion: 'h3.1', images: [image(1)] });
    expect(result.success).toBe(true);
    expect(result.data?.tripoVersion).toBe('v2.5');
  });

  it('runs a submitted H3.1 with the flag', () => {
    const result = submitTripo(
      { tripoH31Generator: true },
      { tripoVersion: 'h3.1', images: [image(1)] }
    );
    expect(result.data?.tripoVersion).toBe('h3.1');
  });
});

describe('Tripo per-version limits', () => {
  it('lets H3.1 take four images and a 2M face limit', () => {
    const result = submitTripo(
      { tripoH31Generator: true },
      { tripoVersion: 'h3.1', images: [1, 2, 3, 4].map(image), faceLimit: 2_000_000 }
    );
    expect(result.success).toBe(true);
    expect(result.data?.images).toHaveLength(4);
    expect(result.data?.faceLimit).toBe(2_000_000);
  });

  it('holds v2.5 to one image and a 500k face limit', () => {
    const store = generationHub.createStore({ ext: ext({}) });
    store.set({
      workflow: 'img2model3d',
      ecosystem: 'Tripo',
      tripoVersion: 'v2.5',
      images: [1, 2].map(image),
      faceLimit: 2_000_000,
    });
    const result = store.validate() as { data?: Record<string, unknown> };
    expect(result.data?.images).toHaveLength(1);
    expect(result.data?.faceLimit).toBe(500_000);
  });
});
