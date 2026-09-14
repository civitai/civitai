import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { videoPreprocessKinds } from '~/shared/data-graph/generation/video-preprocess-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

function store() {
  const s = generationHub.createStore({ ext: EXT });
  s.set({ workflow: 'vid2vid:preprocess' } as never);
  return s;
}

describe('vid2vid:preprocess graph', () => {
  it('offers exactly the kinds preprocessVideo implements', () => {
    const options = store().getField('preprocessKind')?.meta as { options?: { value: string }[] };
    expect(options?.options?.map((o) => o.value).sort()).toEqual(
      ['canny', 'depth-anything-v2', 'dwpose', 'hed', 'mlsd'].sort()
    );
  });

  it('does not offer image-only kinds', () => {
    const values = (
      (store().getField('preprocessKind')?.meta as { options?: { value: string }[] })?.options ?? []
    ).map((o) => o.value);
    for (const imageOnly of ['openpose', 'scribble', 'tile', 'shuffle', 'oneformer-coco']) {
      expect(values).not.toContain(imageOnly);
    }
  });

  it('surfaces per-kind params, and they differ by kind', () => {
    const s = store();
    s.set({ preprocessKind: 'dwpose' } as never);
    const dwpose = (s.getField('kindParams')?.meta as { specs?: { key: string }[] })?.specs ?? [];
    expect(dwpose.map((x) => x.key)).toContain('detectHand');

    s.set({ preprocessKind: 'canny' } as never);
    const canny = (s.getField('kindParams')?.meta as { specs?: { key: string }[] })?.specs ?? [];
    expect(canny.map((x) => x.key).sort()).toEqual(['highThreshold', 'lowThreshold']);
  });

  it('requires a video', () => {
    expect(store().validate().success).toBe(false);
  });

  it('validates once a video is attached', () => {
    const s = store();
    s.set({ video: { url: 'https://example.test/source.mp4' } } as never);
    expect(s.validate().success).toBe(true);
  });

  it('derives its kind list from the H3 ControlNet key list', () => {
    expect([...videoPreprocessKinds].sort()).toEqual(
      ['canny', 'depth-anything-v2', 'dwpose', 'hed', 'mlsd'].sort()
    );
  });
});
