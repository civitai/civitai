import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { viduVersionIds } from '~/shared/generation/version-ids';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const storeOn = (workflow: string, modelId: number) => {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'Vidu', prompt: 'x' });
  store.set({ model: { id: modelId } });
  return store;
};

const meta = <T>(store: ReturnType<typeof storeOn>, key: string) =>
  store.getField(key)?.meta as T | undefined;

describe('Vidu Q4', () => {
  it('picking Q4 on text-to-video moves the form to image-to-video', () => {
    const store = storeOn('txt2vid', viduVersionIds.q4);

    expect(store.getField('workflow')?.value).toBe('img2vid');
  });

  it('image-to-video takes one start frame, Q4 resolutions and a 3-16s duration', () => {
    const store = storeOn('img2vid', viduVersionIds.q4);

    expect(meta<{ max: number }>(store, 'images')?.max).toBe(1);
    expect(
      meta<{ options: { value: string }[] }>(store, 'resolution')?.options.map((o) => o.value)
    ).toEqual(['540p', '720p', '1080p', '2K', '4K']);
    expect(meta<{ min: number; max: number }>(store, 'duration')).toMatchObject({
      min: 3,
      max: 16,
    });
    expect(store.getField('aspectRatio')).toBeNull();
    expect(store.getField('enableAudio')).toBeNull();
    expect(store.getField('style')).toBeNull();
    expect(store.getField('movementAmplitude')).toBeNull();
    expect(store.getField('enablePromptEnhancer')).toBeNull();
    expect(store.getField('draft')).toBeNull();
  });

  it('reference-to-video takes 15 references, a ratio, audio and a 1-16s duration', () => {
    const store = storeOn('img2vid:ref2vid', viduVersionIds.q4);

    expect(meta<{ max: number }>(store, 'images')?.max).toBe(15);
    expect(store.getField('aspectRatio')).not.toBeNull();
    expect(store.getField('enableAudio')).not.toBeNull();
    expect(meta<{ min: number }>(store, 'duration')?.min).toBe(1);
  });

  it('Q1 keeps its two-slot image-to-video and seven references', () => {
    expect(meta<{ max: number }>(storeOn('img2vid', viduVersionIds.q1), 'images')?.max).toBe(2);
    expect(
      meta<{ max: number }>(storeOn('img2vid:ref2vid', viduVersionIds.q1), 'images')?.max
    ).toBe(7);
  });
});
