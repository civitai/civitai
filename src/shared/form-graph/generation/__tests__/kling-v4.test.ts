import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { klingVersionIds } from '~/shared/generation/version-ids';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const storeOn = (workflow: string, modelId: number) => {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'Kling', prompt: 'x' });
  store.set({ model: { id: modelId, model: { type: 'Checkpoint' } } });
  return store;
};

describe('Kling V4', () => {
  it('edits run on V4 with a source video and no duration', () => {
    const store = storeOn('vid2vid:edit', klingVersionIds.v4);

    expect(store.getField('klingVersion')?.value).toBe('v4');
    expect(store.getField('operation')?.value).toBe('videoToVideoEdit');
    expect(store.getField('video')).not.toBeNull();
    expect(store.getField('duration')).toBeNull();
  });

  it('edits move an older model to V4 so the video input exists', () => {
    const store = storeOn('vid2vid:edit', klingVersionIds.v3);

    expect(store.getField('model')?.value).toMatchObject({ id: klingVersionIds.v4 });
    expect(store.getField('video')).not.toBeNull();
  });

  it('ref2vid keeps V4 rather than forcing V3', () => {
    const store = storeOn('img2vid:ref2vid', klingVersionIds.v4);

    expect(store.getField('model')?.value).toMatchObject({ id: klingVersionIds.v4 });
    expect(store.getField('operation')?.value).toBe('referenceToVideo');
  });
});
