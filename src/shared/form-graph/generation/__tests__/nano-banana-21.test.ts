import { describe, expect, it } from 'vitest';
import { createNanoBananaInput } from '~/server/services/orchestrator/form-graph/nano-banana.handler';
import type { GenerationHandlerCtx } from '~/server/services/orchestrator/orchestration-new.service';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { nanoBananaVersionIds } from '~/shared/form-graph/generation/image/nano-banana.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const ctx = {
  airs: { getOrThrow: (id: number) => `air:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

const storeOn = (modelId: number) => {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'txt2img', ecosystem: 'NanoBanana', prompt: 'x' });
  store.set({ model: { id: modelId } });
  return store;
};

const ratios = (modelId: number) =>
  (
    storeOn(modelId).getField('aspectRatio')?.meta as
      | { options?: { value: string }[] }
      | undefined
  )?.options?.map((o) => o.value) ?? [];

describe('Nano Banana 2.1', () => {
  it('has resolution tiers, no seed and no web search', () => {
    const store = storeOn(nanoBananaVersionIds.v21);

    expect(store.getField('nanoBananaMode')?.value).toBe('v21');
    expect(store.getField('resolution')?.value).toBe('1K');
    expect(store.getField('seed')).toBeNull();
    expect(store.getField('enableWebSearch')).toBeNull();
  });

  it('offers the extreme ratios that v2 does not', () => {
    const extremes = ['8:1', '4:1', '9:21', '1:4', '1:8'];

    expect(ratios(nanoBananaVersionIds.v21)).toEqual(expect.arrayContaining(extremes));
    for (const ratio of extremes) expect(ratios(nanoBananaVersionIds.v2)).not.toContain(ratio);
  });

  it('builds a nano-banana-2.1 google input', async () => {
    const [step] = await createNanoBananaInput(
      {
        ecosystem: 'NanoBanana',
        nanoBananaMode: 'v21',
        prompt: 'a banana',
        quantity: 2,
        resolution: '2K',
        aspectRatio: { value: '1:8', width: 2160, height: 17280 },
        images: [{ url: 'https://example.com/a.png' }],
      } as any,
      ctx
    );

    expect(step.input).toEqual({
      engine: 'google',
      model: 'nano-banana-2.1',
      prompt: 'a banana',
      aspectRatio: '1:8',
      resolution: '2K',
      images: ['https://example.com/a.png'],
      numImages: 2,
    });
  });
});
