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
  });
});
