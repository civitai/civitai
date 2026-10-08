import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { MAX_PROMPT_LENGTH, samplers } from '~/shared/constants/generation.constants';
import { SONILO_MAX_PROMPT_LENGTH } from '~/shared/constants/sonilo.constants';
import type { GenerationCtx } from '~/shared/generation/context';

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

  describe('imagesDef', () => {
    const editStore = (ecosystem: string, workflow = 'img2img:edit') => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow, ecosystem, prompt: 'a cat' });
      return store;
    };
    const img = (i: number) => ({
      url: `https://image.civitai.com/x/${i}.jpeg`,
      width: 1024,
      height: 1024,
    });
    const capOf = (store: Store) => (store.getField('images')?.meta as { max: number }).max;

    // A 9-image upscale remixed onto a 3-image edit family is the shape that was failing:
    // the cap lived only in the `input` transform, which a trusted `set()` skips.
    //
    // Sized from the field's own `meta.max` rather than a frozen table — Qwen's cap is
    // CONDITIONAL (`Qwen21 ? 10 : 3`) and three families already sit at 9, so a literal
    // here rots into a failure that points at the test. `meta.max` is the DECLARED
    // contract (the slot count the picker renders); the hook is the enforcement, and
    // "enforcement matches declaration" is the property worth pinning.
    it.each([
      ['Qwen', 'img2img:edit'],
      ['Ming', 'img2img:edit'],
      ['Flux2', 'img2img:edit'],
      // slots-derived cap, where WHICH images survive is the whole semantics: keeping the
      // last two would put the wrong frame in "Start Image" with every length assertion green.
      ['Kling', 'img2vid'],
    ])('%s/%s truncates an over-cap array from the FRONT', (ecosystem, workflow) => {
      const store = editStore(ecosystem, workflow);
      const max = capOf(store);
      const sent = Array.from({ length: max + 1 }, (_, i) => img(i));
      store.set({ images: sent });

      expectValid(store);
      // Identity, not length: `slice(-max)` keeps the right COUNT and the wrong images.
      expect(state(store).images).toEqual(sent.slice(0, max));
      // The row must be about the family it names — ecosystem correction is live in this
      // graph, and a coincidentally-equal cap would otherwise keep it green elsewhere.
      expect(state(store).ecosystem).toBe(ecosystem);
      expect(store.getNotes()).toContainEqual(
        expect.objectContaining({ key: 'images', kind: 'over_cap' })
      );
    });

    // The single-slot edge, pinned as a literal: it is the one row where "always truncate
    // to 1" would otherwise be indistinguishable from truncating to the cap.
    it('MAI keeps exactly its one slot', () => {
      const store = editStore('MAI');
      expect(capOf(store)).toBe(1);
      store.set({ images: [img(0), img(1)] });

      expectValid(store);
      expect(state(store).images).toEqual([img(0)]);
    });

    it('leaves an at-cap array alone, with no note', () => {
      const store = editStore('Qwen');
      const images = Array.from({ length: capOf(store) }, (_, i) => img(i));
      store.set({ images });

      expectValid(store);
      expect(state(store).images).toEqual(images);
      // `slice` returns a fresh array, so an UNCONDITIONAL correct passes the deep compare
      // above and emits a "we trimmed your images" note on every at-cap edit. This is the
      // assertion that catches that.
      expect(store.getNotes()).not.toContainEqual(
        expect.objectContaining({ key: 'images', kind: 'over_cap' })
      );
    });

    // Extract Metadata's "Image To Image" handed over a bare URL, and the images input
    // crashed on `.url` of it.
    it('turns a bare URL string into an image entry', () => {
      const store = editStore('Qwen');
      const url = img(0).url;
      store.set({ images: [url] });

      expect(state(store).images).toEqual([{ url }]);
    });

    it('caps a mix of strings and entries to the field max', () => {
      const store = editStore('MAI');
      store.set({ images: [img(0).url, img(1)] });

      expect(state(store).images).toEqual([{ url: img(0).url }]);
    });

    // The MIN side must stay an error — `correct` cannot invent an image, and "you need a
    // source image" is a state the user has to resolve rather than one to paper over.
    it('still REFUSES too few images, and does not correct them', () => {
      const store = editStore('Qwen');
      store.set({ images: [] });

      const result = store.validate();
      expect(result.success).toBe(false);
      expect(result.success === false && result.errors.images?.message).toMatch(/required/i);
      // Separates "the hook declined to act" from "the untouched default refused".
      expect(store.getNotes()).not.toContainEqual(expect.objectContaining({ key: 'images' }));
    });
  });

  // 17% of stored images carry a seed past the uint32 cap, so this is the widest instance
  // of the trusted-write class — every one of those images was unremixable.
  describe('SEED', () => {
    // 0 is a very common stored seed, and NaN/non-integers arrive from `?gen=` handoffs and
    // parsed metadata. A bounds-only guard is false for NaN and misses 1.5 entirely.
    it.each([
      ['above the cap', 9_999_999_999_999],
      ['zero', 0],
      ['negative', -5],
      ['non-integer', 1.5],
      ['NaN', NaN],
    ])('drops an unreproducible seed (%s) rather than refusing', (_label, seed) => {
      const store = makeStore('SDXL');
      store.set({ seed });

      expectValid(store);
      // A CLAMP would also pass `expectValid` — this is what makes it a drop.
      expect(state(store).seed).toBeUndefined();
      expect(store.getNotes()).toContainEqual(
        expect.objectContaining({ key: 'seed', kind: 'seed_unreproducible' })
      );
    });

    it('leaves an in-range seed alone, with no note', () => {
      const store = makeStore('SDXL');
      store.set({ seed: 42 });

      expectValid(store);
      expect(state(store).seed).toBe(42);
      expect(store.getNotes()).not.toContainEqual(expect.objectContaining({ key: 'seed' }));
    });
  });

  describe('textDef', () => {
    // Sonilo's 2000 is the realistic case, not the 6000 default: a long SDXL prompt
    // remixed onto a family with a tighter cap is what produced the dead button.
    it.each([
      ['SDXL', 'txt2img', 'prompt', MAX_PROMPT_LENGTH],
      ['Sonilo', 'txt2music', 'prompt', SONILO_MAX_PROMPT_LENGTH],
    ])('%s truncates an over-length %s from the FRONT', (ecosystem, workflow, key, cap) => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow, ecosystem });
      // Marked payload: a homogeneous 'x'.repeat() cannot tell truncation direction apart.
      store.set({ [key]: `HEAD${'x'.repeat(cap)}` });

      expectValid(store);
      const value = state(store)[key] as string;
      expect(value.length).toBe(cap);
      expect(value.startsWith('HEAD')).toBe(true);
      // No note asserted: `coerce` does not emit one. Nothing in the app renders a
      // resolution note today anyway, so the truncation is silent either way.
    });

    it('leaves a short prompt alone', () => {
      const store = makeStore('SDXL');
      store.set({ prompt: 'a cat' });

      expectValid(store);
      expect(state(store).prompt).toBe('a cat');
    });

    // Leading whitespace must not count toward the cap: `output` is `.trim().max()`, so a
    // value that only exceeds it untrimmed needed no truncation at all.
    it('does not truncate a value that only exceeds the cap untrimmed', () => {
      const store = makeStore('SDXL');
      store.set({
        prompt: `
   ${'x'.repeat(MAX_PROMPT_LENGTH - 2)}`,
      });

      expectValid(store);
      expect((state(store).prompt as string).endsWith('xx')).toBe(true);
    });
  });

  // Duration ranges differ per family (Grok 6–15, Kling V3 5–15, Wan 2–15), so a video
  // remix carries an out-of-range one routinely. `refusingRangeDef` is named for refusing,
  // and it still does — at the PARSE boundary, which the last case in this file pins.
  describe('refusingRangeDef', () => {
    it('clamps a duration from another family into range', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'a cat' });
      const meta = store.getField('duration')?.meta as { min: number; max: number };
      store.set({ duration: meta.min - 1 });

      expectValid(store);
      expect(state(store).duration).toBe(meta.min);
    });

    it('leaves an in-range duration alone', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'a cat' });
      const meta = store.getField('duration')?.meta as { min: number; max: number };
      store.set({ duration: meta.min });

      expectValid(store);
      expect(state(store).duration).toBe(meta.min);
    });

    // NEGATIVE CONTROL. Both cases above land on `meta.min`, and Grok's range starts at its
    // own default (6), so an UNCONDITIONAL clamp to min satisfies them and nothing else in
    // the repo asserts `duration`. That mutation would collapse every `refusingRangeDef`
    // field to its family floor — Kling V3 duration to 5s, LTX `numFrames` to a single frame.
    it('leaves a value strictly inside the range alone', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'a cat' });
      const meta = store.getField('duration')?.meta as { min: number; max: number };
      const inside = Math.floor((meta.min + meta.max) / 2);
      expect(inside).toBeGreaterThan(meta.min);
      store.set({ duration: inside });

      expectValid(store);
      expect(state(store).duration).toBe(inside);
    });

    it('clamps DOWN to max, not to min', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'a cat' });
      const meta = store.getField('duration')?.meta as { min: number; max: number };
      store.set({ duration: meta.max + 1 });

      expectValid(store);
      expect(state(store).duration).toBe(meta.max);
    });
  });

  // `max` is the user's OWN `limits.maxQuantity`, so this fires on an entitlement change
  // as well as an ingestion — and the call site in `image/hub.graph.ts` overrode the def's
  // hook to add a bogo step floor, which dropped the ceiling until it was made to fall through.
  describe('quantityDef', () => {
    const freeExt = {
      ...EXT,
      limits: { maxQuantity: 1, maxResources: 1, vidQuantity: 1 },
      user: { isMember: false, tier: 'free' },
    } as typeof EXT;

    it("clamps a quantity above the user's own cap", () => {
      const store = generationHub.createStore({ ext: freeExt });
      store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });
      store.set({ quantity: 4 });

      expectValid(store);
      expect(state(store).quantity).toBe(1);
    });

    it('still raises a quantity below the step floor', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });
      const meta = store.getField('quantity')?.meta as { min: number };
      store.set({ quantity: 0 });

      expectValid(store);
      expect(state(store).quantity).toBe(meta.min);
    });
  });

  // The video hub declares its OWN quantity field (`video/hub.graph.ts`), hand-written rather
  // than built from `quantityDef`, so the image hub's fix did not reach it. Same hole: a
  // quantity carried over by a remix from an image family fails the video output.
  // Pinned to LTXV25 because the field mounts only for VID_QUANTITY_ECOSYSTEMS.
  describe("the video hub's own quantity", () => {
    const freeExt = {
      ...EXT,
      limits: { maxQuantity: 1, maxResources: 1, vidQuantity: 1 },
      user: { isMember: false, tier: 'free' },
    } as typeof EXT;

    it("clamps a quantity above the user's own video cap", () => {
      const store = generationHub.createStore({ ext: freeExt });
      store.set({ workflow: 'txt2vid', ecosystem: 'LTXV25', prompt: 'a cat' });
      store.set({ quantity: 4 });

      expectValid(store);
      expect(state(store).quantity).toBe(1);
    });

    it('leaves an in-range video quantity alone', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({ workflow: 'txt2vid', ecosystem: 'LTXV25', prompt: 'a cat' });
      const meta = store.getField('quantity')?.meta as { max: number };
      expect(meta.max).toBeGreaterThan(1);
      store.set({ quantity: meta.max });

      expectValid(store);
      expect(state(store).quantity).toBe(meta.max);
    });
  });
  // controlNets are stored GLOBALLY, so staged nets outlive the family whose limit they
  // were staged under.
  describe('controlNetsDef', () => {
    const net = (u: string) => ({
      preprocessor: 'canny',
      image: { url: `https://image.civitai.com/${u}.png`, width: 8, height: 8 },
      weight: 1,
      startStep: 0,
      endStep: 1,
      mode: 'auto',
    });

    it('truncates staged nets to the active family limit', () => {
      const store = generationHub.createStore({ ext: EXT });
      store.set({
        workflow: 'txt2img',
        ecosystem: 'Flux1',
        prompt: 'a cat',
        model: { id: 1, model: { type: 'Checkpoint' } },
      });
      const meta = store.getField('controlNets')?.meta as { limit?: number } | undefined;
      // Not `?? 1`: every live call site passes `limit: 1`, so a fallback is
      // indistinguishable from reading the declaration and the test would still pass
      // after `meta.limit` was renamed away.
      expect(typeof meta?.limit, 'controlNets meta must carry a limit').toBe('number');
      const limit = meta!.limit!;
      const staged = Array.from({ length: limit + 1 }, (_, i) => net(String(i)));
      store.set({ controlNets: staged });

      expectValid(store);
      // Identity, not length: `slice(-limit)` keeps the right COUNT and the wrong nets,
      // and which staged net survives a family switch is the whole point of the hook.
      const kept = state(store).controlNets as Array<{ image: { url: string } }>;
      expect(kept.map((n) => n.image.url)).toEqual(staged.slice(0, limit).map((n) => n.image.url));
    });
  });

  // 🔴 THE TRUSTED/UNTRUSTED SPLIT, which is why the text fix is a `coerce` and the other
  // two are `correct`s. `correct` runs on the SERVER parse as well, and `textDef.input`
  // carries no length bound — so putting the truncation there turned an over-length prompt
  // from a 400 into a silent truncate-and-bill on a path billed per generation
  // (`orchestrator.generateFromGraph` takes `z.any()`; the graph IS the input contract).
  //
  // Both directions are asserted because each alone is satisfiable by the wrong fix.
  describe('the parse boundary stays strict', () => {
    const parse = (raw: Record<string, unknown>) => generationHub.parse(raw as never, EXT);

    it('REFUSES an over-length prompt rather than truncating it', () => {
      const result = parse({
        workflow: 'txt2img',
        ecosystem: 'SDXL',
        prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1000),
      });

      expect(result.success).toBe(false);
      expect(result.success === false && Object.keys(result.errors)).toContain('prompt');
    });

    // The counterpart: these two normalise in `input`, so their `correct` hooks are
    // no-ops here and the parse accepts — pinning that the hooks did not change the
    // server's answer for them either.
    it('accepts an over-cap seed and images, already normalised by input', () => {
      const result = parse({
        workflow: 'img2img:edit',
        ecosystem: 'Qwen',
        prompt: 'a cat',
        seed: 9_999_999_999_999,
        images: Array.from({ length: 9 }, (_, i) => ({
          url: `https://image.civitai.com/x/${i}.jpeg`,
          width: 1024,
          height: 1024,
        })),
      });

      expect(result.success).toBe(true);
      const data = result.success ? (result.data as Record<string, unknown>) : {};
      expect(data.seed).toBeUndefined();
      expect((data.images as unknown[]).length).toBe(3);
    });
  });
});
