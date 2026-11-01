import { describe, expect, it, vi } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { getWorkflowModes } from '~/shared/generation/config/workflows';
import { flux3VideoVersionIds } from '~/shared/generation/version-ids';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const V3 = flux3VideoVersionIds['v3.0'];
const MAX = flux3VideoVersionIds['v3.0-max'];
const IMAGE = { url: 'https://example.com/a.png', width: 1216, height: 832 };
const IMAGE2 = { url: 'https://example.com/b.png', width: 1216, height: 832 };

const storeOn = (workflow: string, modelId: number) => {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'Flux3Video', prompt: 'x' });
  store.set({ model: { id: modelId } });
  return store;
};

const parse = (input: Record<string, unknown>) =>
  generationHub.parse({ ecosystem: 'Flux3Video', prompt: 'x', ...input }, EXT);

describe('Flux 3 Video versions', () => {
  it('v3.0 keeps draft mode and has none of the Max controls', () => {
    const store = storeOn('txt2vid', V3);

    expect(store.getField('draft')).not.toBeNull();
    expect(store.getField('reasoningLevel')).toBeNull();
    expect(store.getField('seed')).toBeNull();
    expect(store.getField('keyframes')).toBeNull();
  });

  it('Max trades draft mode for reasoning, a seed and audio on by default', () => {
    const store = storeOn('txt2vid', MAX);

    expect(store.getField('draft')).toBeNull();
    expect(store.getField('reasoningLevel')?.value).toBe('high');
    expect(store.getField('seed')).not.toBeNull();
    expect(store.getField('generateAudio')?.value).toBe(true);
    expect(store.getField('keyframes')).toBeNull();
  });

  it('the video mode toggle offers keyframes on Max and not on v3.0', () => {
    const modes = (modelId: number) =>
      getWorkflowModes('txt2vid', 'Flux3Video', modelId).map((m) => m.value);

    expect(modes(MAX)).toEqual(['txt2vid', 'img2vid', 'img2vid:keyframes']);
    expect(modes(V3)).toEqual(['txt2vid', 'img2vid']);
  });

  it('keyframes to video forces the model to Max', () => {
    const store = storeOn('img2vid:keyframes', V3);

    expect((store.getField('model')?.value as { id: number }).id).toBe(MAX);
    expect(store.getField('images')).toBeNull();
    expect(store.getField('keyframes')).not.toBeNull();
  });

  it('dragging the duration does not rebuild the keyframes schemas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = storeOn('img2vid:keyframes', MAX);
      for (const duration of [6, 7, 8, 9, 10]) store.set({ duration });

      expect(warn.mock.calls.filter(([msg]) => String(msg).includes('keyframes'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('the last reachable keyframe follows the duration at 24 fps', () => {
    const store = storeOn('img2vid:keyframes', MAX);
    store.set({ duration: 10 });

    expect(store.getField('keyframes')?.meta).toMatchObject({ maxFrame: 240 });
  });
});

describe('Flux 3 Max keyframes at the parse boundary', () => {
  const keyframes = (entries: { image: unknown; frameIndex: number }[]) =>
    parse({ workflow: 'img2vid:keyframes', model: { id: MAX }, duration: 5, keyframes: entries });

  it('accepts distinct frames inside the video and drops entries without an image', () => {
    const result = keyframes([
      { image: IMAGE, frameIndex: 0 },
      { image: undefined, frameIndex: 24 },
      { image: IMAGE2.url, frameIndex: 120 },
    ]);

    expect(result.success).toBe(true);
    expect((result.data as { keyframes: unknown }).keyframes).toEqual([
      { image: IMAGE, frameIndex: 0 },
      { image: { url: IMAGE2.url }, frameIndex: 120 },
    ]);
  });

  it('refuses two keyframes on the same frame', () => {
    const result = keyframes([
      { image: IMAGE, frameIndex: 24 },
      { image: IMAGE2, frameIndex: 24 },
    ]);

    expect(result.success).toBe(false);
  });

  it('pulls a keyframe past the end of the video back to the last frame', () => {
    const result = keyframes([{ image: IMAGE, frameIndex: 121 }]);

    expect(result.success).toBe(true);
    expect((result.data as { keyframes: unknown }).keyframes).toEqual([
      { image: IMAGE, frameIndex: 120 },
    ]);
  });

  it('shortening the video pulls a keyframe placed past its new end back in', () => {
    const store = storeOn('img2vid:keyframes', MAX);
    store.set({ duration: 10, keyframes: [{ image: IMAGE, frameIndex: 240 }] });
    store.set({ duration: 5 });

    expect(store.getField('keyframes')?.value).toEqual([{ image: IMAGE, frameIndex: 120 }]);
  });

  it('refuses a keyframes submission with no images', () => {
    const result = keyframes([]);

    expect(result.success).toBe(false);
  });
});
