import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { seedanceVersionIds } from '../video/seedance.graph';
import { klingVersionIds, grokVersionIds } from '~/shared/data-graph/generation/version-ids';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * The reshape-under-sibling class: a field whose def (range / option set /
 * default) is computed from a SIBLING field must not strand a trusted value
 * that the new def refuses — validate() would fail and the submit button dies
 * silently. Each case drives the store through the sibling switch and pins
 * that validate stays green and the value lands where the fix put it
 * (per-mode scope bucket, or a correction). The minimax turbo case that
 * found the class lives in minimax-turbo-scope.test.ts.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const makeStore = (ext: GenerationCtx = EXT) => generationHub.createStore({ ext });

const val = (store: ReturnType<typeof makeStore>, key: string) => store.getField(key)?.value;

const expectValid = (store: ReturnType<typeof makeStore>, label: string) => {
  const result = store.validate();
  if (!result.success) {
    throw new Error(`${label}: validate failed on ${JSON.stringify(Object.keys(result.errors))}`);
  }
  expect(result.success).toBe(true);
};

describe('seedance: model switch reshapes resolution options and duration range', () => {
  it('1080p on v2 does not ride onto v2-mini; each model remembers its own', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'Seedance', prompt: 'x' });
    store.set({ model: { id: seedanceVersionIds.v2, model: { type: 'Checkpoint' } } });
    store.set({ resolution: '1080p' });

    store.set({ model: { id: seedanceVersionIds['v2-mini'], model: { type: 'Checkpoint' } } });
    expect(val(store, 'resolution')).not.toBe('1080p');
    expectValid(store, 'seedance resolution');

    store.set({ model: { id: seedanceVersionIds.v2, model: { type: 'Checkpoint' } } });
    expect(val(store, 'resolution')).toBe('1080p');
  });

  it('duration 20 on v2.5 does not ride onto the max-15 models', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'Seedance', prompt: 'x' });
    store.set({ model: { id: seedanceVersionIds['v2.5'], model: { type: 'Checkpoint' } } });
    store.set({ duration: 20 });

    store.set({ model: { id: seedanceVersionIds['v2-mini'], model: { type: 'Checkpoint' } } });
    expect(val(store, 'duration')).toBeLessThanOrEqual(15);
    expectValid(store, 'seedance duration');
  });
});

describe('kling: legacy string-enum duration vs v3 number range', () => {
  it('a version switch never leaves the other arm type stranded', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'Kling', prompt: 'x' });
    store.set({ model: { id: klingVersionIds.v1_6, model: { type: 'Checkpoint' } } });
    store.set({ duration: '10' });
    expectValid(store, 'kling legacy');

    store.set({ model: { id: klingVersionIds.v3, model: { type: 'Checkpoint' } } });
    expect(typeof val(store, 'duration')).toBe('number');
    store.set({ duration: 12 });
    expectValid(store, 'kling v3');

    store.set({ model: { id: klingVersionIds.v1_6, model: { type: 'Checkpoint' } } });
    expect(val(store, 'duration')).toBe('10');
    expectValid(store, 'kling back to legacy');
  });
});

describe('grok video: v1.5 adds 1080p', () => {
  it('a 1080p pick does not ride onto v1.0', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'x' });
    store.set({ model: { id: grokVersionIds['v1.5'], model: { type: 'Checkpoint' } } });
    store.set({ resolution: '1080p' });

    store.set({ model: { id: grokVersionIds['v1.0'], model: { type: 'Checkpoint' } } });
    expect(val(store, 'resolution')).not.toBe('1080p');
    expectValid(store, 'grok video resolution');
  });
});

describe('ltx: duration range differs per resolution', () => {
  it('18s at 720p does not ride onto the max-15 1080p', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'LTXV23', prompt: 'x' });
    store.set({ duration: 18 });

    store.set({ resolution: '1080p' });
    expect(val(store, 'duration')).toBeLessThanOrEqual(15);
    expectValid(store, 'ltx duration per resolution');

    store.set({ resolution: '720p' });
    expect(val(store, 'duration')).toBe(18);
  });

  it("v23's slider duration does not ride onto v2's enum", () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'LTXV23', prompt: 'x' });
    store.set({ duration: 20 });

    store.set({ ecosystem: 'LTXV2' });
    expectValid(store, 'ltx v2 enum duration');
  });
});

describe('wan: resolution and duration options differ per version in one family bucket', () => {
  it("2.5's 1080p and 10s do not ride onto 2.2", () => {
    const store = makeStore();
    store.set({ workflow: 'txt2vid', ecosystem: 'WanVideo-25-T2V', prompt: 'x' });
    store.set({ resolution: '1080p', duration: 10 });
    expectValid(store, 'wan 2.5');

    store.set({ ecosystem: 'WanVideo-22-T2V-A14B' });
    expectValid(store, 'wan after switch');
  });
});

describe('flux2-klein: base steps range does not ride onto distilled', () => {
  it('steps 30 on Base is not stranded on the max-12 distilled arm', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'Flux2Klein_9B_base', prompt: 'x' });
    store.set({ steps: 30 });
    expectValid(store, 'klein base');

    store.set({ ecosystem: 'Flux2Klein_9B' });
    expect(Number(val(store, 'steps'))).toBeLessThanOrEqual(12);
    expectValid(store, 'klein distilled');
  });
});

describe('image hub: bogo quantity floor', () => {
  it('a stored quantity below the bogo step is corrected, not stranded', () => {
    const ext: GenerationCtx = {
      ...EXT,
      flags: { enhancedCompatibilitySdcpp: true } as GenerationCtx['flags'],
    };
    const store = generationHub.createStore({ ext });
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'x' });
    store.set({ quantity: 1 });
    expectValid(store, 'quantity pre-bogo');

    // Must be on SDCPP_SUPPORTED_ECOSYSTEMS (the bogo list), and not the starting SDXL.
    store.set({ ecosystem: 'Flux2Klein_9B' });
    expect(Number(val(store, 'quantity'))).toBeGreaterThanOrEqual(2);
    expectValid(store, 'quantity under bogo');
  });

  it('ZImage is off the 2-for-1 bonus, so a stored quantity of 1 stands', () => {
    const ext: GenerationCtx = {
      ...EXT,
      flags: { enhancedCompatibilitySdcpp: true } as GenerationCtx['flags'],
    };
    const store = generationHub.createStore({ ext });
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'x' });
    store.set({ quantity: 1 });

    store.set({ ecosystem: 'ZImageBase' });
    expect(Number(val(store, 'quantity'))).toBe(1);
    expectValid(store, 'ZImage quantity');
  });
});

describe('grok image: v2 image cap', () => {
  it('7 staged images truncate to 3 on a v2 switch instead of failing max(3)', () => {
    const store = makeStore({
      ...EXT,
      flags: { grokImagine2: true } as GenerationCtx['flags'],
    });
    store.set({ workflow: 'img2img:edit', ecosystem: 'Grok', prompt: 'x' });
    const img = (i: number) => ({ url: `https://example.com/${i}.png`, width: 512, height: 512 });
    store.set({ model: { id: grokVersionIds['v1.5'], model: { type: 'Checkpoint' } } });
    store.set({ images: [1, 2, 3, 4, 5].map(img) });
    expectValid(store, 'grok image v1.5');

    store.set({ model: { id: grokVersionIds['v2.0'], model: { type: 'Checkpoint' } } });
    expect((val(store, 'images') as unknown[]).length).toBeLessThanOrEqual(3);
    expectValid(store, 'grok image v2');
  });
});

describe('video-enhance: scale factor remembered per source size', () => {
  it('x2 picked for a small video does not fail the ceiling refine on a larger one', () => {
    const store = makeStore();
    const video = (width: number, height: number) => ({
      url: 'https://example.com/a.mp4',
      metadata: { width, height, fps: 30, duration: 5 },
    });
    store.set({ workflow: 'vid2vid:upscale' });
    store.set({ video: video(640, 360) });
    store.set({ scaleFactor: 3 });
    expectValid(store, 'small video');

    // 1000px: x3 would exceed the 2560 ceiling, x2 is fine — the new size
    // bucket re-derives a valid default instead of stranding the trusted 3
    store.set({ video: video(1000, 562) });
    expect(Number(val(store, 'scaleFactor')) * 1000).toBeLessThanOrEqual(2560);
    expectValid(store, 'larger video');
  });
});
