import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { samplers } from '~/shared/constants/generation.constants';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * A value the ACTIVE constraint does not allow must be corrected to something it
 * does, not left to fail output validation.
 *
 * `store.set` writes TRUSTED intent, which skips the def's `input` schema outright,
 * so remix ingestion lands another family's settings in state uncoerced — and the
 * form-graph footer returns on a failed `store.validate()`, which reads as a dead
 * Generate button. Each case below is a field that produced exactly that.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

type Store = ReturnType<typeof generationHub.createStore>;

function makeStore(ecosystem: string) {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'txt2img', ecosystem, prompt: 'a cat' });
  return store;
}

const state = (store: Store) => store.getSnapshot().state as Record<string, unknown>;

function expectValid(store: Store) {
  const result = store.validate();
  expect(
    result.success,
    `validate must not refuse a correctable value: ${JSON.stringify(
      'errors' in result ? result.errors : {}
    )}`
  ).toBe(true);
}

describe('def constraint correction', () => {
  describe('selectDef', () => {
    it("corrects another family's sampler", () => {
      const store = makeStore('SDXL');
      // flux2-klein's default. SD's options are capitalised, so 'euler' is out of set.
      store.set({ sampler: 'euler' });

      expectValid(store);
      expect(samplers as readonly string[]).toContain(state(store).sampler);
    });

    it('leaves an in-set sampler alone', () => {
      const store = makeStore('SDXL');
      store.set({ sampler: 'DPM++ 2M Karras' });

      expectValid(store);
      expect(state(store).sampler).toBe('DPM++ 2M Karras');
    });
  });

  describe('sliderDef', () => {
    it('snaps out-of-range numbers into the active range', () => {
      const store = makeStore('SDXL');
      store.set({ steps: 9999, cfgScale: 999, clipSkip: 77 });

      expectValid(store);
      for (const key of ['steps', 'cfgScale', 'clipSkip']) {
        const meta = store.getField(key)?.meta as { min: number; max: number } | undefined;
        expect(meta, `${key} must be active`).toBeDefined();
        expect(state(store)[key], `${key} above its max`).toBeLessThanOrEqual(meta!.max);
        expect(state(store)[key], `${key} below its min`).toBeGreaterThanOrEqual(meta!.min);
      }
    });

    it('leaves an in-range number alone', () => {
      const store = makeStore('SDXL');
      store.set({ steps: 25, cfgScale: 4 });

      expectValid(store);
      expect(state(store).steps).toBe(25);
      expect(state(store).cfgScale).toBe(4);
    });
  });

  describe('enumDef', () => {
    it('falls back to the default for an out-of-set option', () => {
      const store = makeStore('HiDream-O1');
      store.set({ resolution: 'NOPE' });

      expectValid(store);
      const meta = store.getField('resolution')?.meta as
        | { options: { value: string }[] }
        | undefined;
      expect(meta?.options.map((o) => o.value)).toContain(state(store).resolution);
    });

    it('leaves an in-set option alone', () => {
      const store = makeStore('HiDream-O1');
      const meta = store.getField('resolution')?.meta as { options: { value: string }[] };
      const last = meta.options[meta.options.length - 1]!.value;
      store.set({ resolution: last });

      expectValid(store);
      expect(state(store).resolution).toBe(last);
    });
  });

  describe('aspectRatioDef', () => {
    // This one never blocked submit: output checks SHAPE, not membership, so the
    // uncorrected value validated and was sent to the orchestrator.
    it('moves a ratio the ecosystem does not offer to the closest it does', () => {
      const store = makeStore('SD1');
      store.set({ aspectRatio: { value: '21:9', width: 2100, height: 900 } });

      expectValid(store);
      const meta = store.getField('aspectRatio')?.meta as { options: { value: string }[] };
      const chosen = state(store).aspectRatio as { value: string };
      expect(meta.options.map((o) => o.value)).toContain(chosen.value);
    });

    it('leaves an offered ratio alone', () => {
      const store = makeStore('SD1');
      const meta = store.getField('aspectRatio')?.meta as {
        options: { value: string; width: number; height: number }[];
      };
      const offered = meta.options[meta.options.length - 1]!;
      store.set({ aspectRatio: offered });

      expectValid(store);
      expect((state(store).aspectRatio as { value: string }).value).toBe(offered.value);
    });

    const FULL = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '9:21'];
    const values = (store: Store) =>
      (store.getField('aspectRatio')?.meta as { options: { value: string }[] }).options.map(
        (o) => o.value
      );

    it.each([
      'SDXL',
      'Anima',
      'Flux1',
      'FluxKrea',
      'Flux2',
      'Flux2Klein_9B',
      'Flux2Klein_4B_base',
      'ZImageTurbo',
      'ZImageBase',
      'Chroma',
      'HiDream',
      'PonyV7',
      'Boogu',
      'Ideogram',
    ])('gives %s the full bucket set', (ecosystem) => {
      const store = makeStore(ecosystem);
      expect(values(store)).toEqual(FULL);

      store.set({ aspectRatio: '21:9' });
      expectValid(store);
      expect(state(store).aspectRatio).toEqual({ value: '21:9', width: 1536, height: 640 });
    });

    // BFL's flux1-pro takes 256–1440 per side, so the 1536-long buckets would be refused.
    it('drops 21:9 and 9:21 for Flux.1 Pro, moving a carried-over one to the closest', () => {
      const store = makeStore('Flux1');
      store.set({ aspectRatio: '21:9' });
      store.set({ model: { id: 922358, model: { type: 'Checkpoint' } } });

      expect(values(store)).toEqual(['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16']);
      expectValid(store);
      expect(state(store).aspectRatio).toEqual({ value: '16:9', width: 1344, height: 768 });
    });

    // Ultra's 16:9 is 2752×1536; the label exists in Standard and Pro too, so a
    // label-only check kept Ultra's size in state after the switch.
    it.each([
      ['Standard', 691639],
      ['Pro', 922358],
    ])("resizes Flux Ultra's 16:9 on a switch to %s", (_, id) => {
      const store = makeStore('Flux1');
      store.set({ model: { id: 1088507, model: { type: 'Checkpoint' } } });
      store.set({ aspectRatio: { value: '16:9', width: 2752, height: 1536 } });
      store.set({ model: { id, model: { type: 'Checkpoint' } } });

      expectValid(store);
      expect(state(store).aspectRatio).toEqual({ value: '16:9', width: 1344, height: 768 });
    });
  });
});
