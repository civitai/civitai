import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};
const video = (width = 640, height = 360) => ({
  url: 'https://example.com/video.mp4',
  metadata: { width, height, fps: 24, duration: 5 },
});
const input = { workflow: 'vid2vid:upscale', video: video() };

describe('video upscaling', () => {
  it('defaults new requests to RelayVSR x2', () => {
    const result = generationHub.parse(input, EXT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      videoUpscaler: 'relayvsr',
      scaleFactor: 2,
      targetDimensions: { width: 1280, height: 720 },
    });
  });

  it.each([
    ['relayvsr', 2, 1280, 720, true],
    ['relayvsr', 4, 640, 360, true],
    ['relayvsr', 3, 640, 360, false],
    ['relayvsr', 4, 641, 360, false],
    ['relayvsr', 2, 720, 1281, false],
    ['flashvsr', 2, 1280, 720, true],
    ['flashvsr', 3, 853, 480, true],
    ['flashvsr', 3, 854, 480, false],
  ])('validates %s x%s at %sx%s', (videoUpscaler, scaleFactor, width, height, valid) => {
    expect(
      generationHub.parse(
        { ...input, video: video(width as number, height as number), videoUpscaler, scaleFactor },
        EXT
      ).success
    ).toBe(valid);
  });

  it('normalizes an unknown model to the default before building a request', () => {
    const result = generationHub.parse({ ...input, videoUpscaler: 'unknown' }, EXT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ videoUpscaler: 'relayvsr' });
  });

  it('offers only each model’s factors and remembers them independently', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set(input);
    const factors = () => store.getField('scaleFactor')?.meta?.options.map((o) => o.value);
    expect(factors()).toEqual([2, 4]);
    store.set({ scaleFactor: 4 });

    store.set({ videoUpscaler: 'flashvsr' });
    expect(factors()).toEqual([2, 3]);
    expect(store.getField('scaleFactor')?.value).toBe(2);
    store.set({ scaleFactor: 3 });

    store.set({ videoUpscaler: 'relayvsr' });
    expect(store.getField('scaleFactor')?.value).toBe(4);
    expect(store.validate().success).toBe(true);
    store.set({ videoUpscaler: 'flashvsr' });
    expect(store.getField('scaleFactor')?.value).toBe(3);
    expect(store.validate().success).toBe(true);
  });

  it('disables x4 and resets the factor when a larger source is selected', () => {
    const store = generationHub.createStore({ ext: EXT });
    store.set(input);
    store.set({ scaleFactor: 4 });
    store.set({ video: video(1280, 720) });
    expect(store.getField('scaleFactor')?.value).toBe(2);
    expect(store.getField('scaleFactor')?.meta?.options).toEqual([
      expect.objectContaining({ value: 2, disabled: false }),
      expect.objectContaining({ value: 4, disabled: true }),
    ]);
    expect(store.validate().success).toBe(true);
  });

  it('does not restore a legacy FlashVSR x3 choice into RelayVSR', () => {
    const store = generationHub.createStore({
      ext: EXT,
      storage: { load: () => ({ 'scaleFactor@640': 3 }), save: () => undefined },
    });
    store.set(input);
    expect(store.getField('videoUpscaler')?.value).toBe('relayvsr');
    expect(store.getField('scaleFactor')?.value).toBe(2);
    expect(store.validate().success).toBe(true);
  });
});
