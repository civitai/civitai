import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { SONILO_MAX_PROMPT_LENGTH } from '~/shared/constants/sonilo.constants';
import { MAX_PROMPT_LENGTH } from '~/shared/form-graph/generation/defs';
import { applyGenerationData } from '../ingestion';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { wildcards: true },
  gateRules: [],
};

const makeStore = (record?: Record<string, unknown>) =>
  generationHub.createStore({
    ext: EXT,
    storage: record ? { load: () => record, save: () => undefined } : undefined,
  });

const state = (store: ReturnType<typeof makeStore>) =>
  store.getSnapshot().state as Record<string, unknown>;

// Payloads are typed against the real signature so a GenerationData shape
// change fails to compile here; only the resource entries stay a narrow cast
// (fixtures carry the subset toResourceData reads, not full GenerationResource).
type Payload = Parameters<typeof applyGenerationData>[1];
const res = (r: Record<string, unknown>) => r as unknown as Payload['resources'][number];

describe('applyGenerationData (v1 GenerationFormProvider parity)', () => {
  it('remix: full override, but output settings survive the reset', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', quantity: 4, prompt: 'my old prompt' });
    applyGenerationData(store, {
      runType: 'remix',
      params: {
        workflow: 'txt2img',
        ecosystem: 'Illustrious',
        prompt: 'remixed prompt',
        quantity: 1, // must NOT override the user's 4
      },
      resources: [res({ id: 555, model: { type: 'Checkpoint' }, baseModel: 'Illustrious' })],
    } satisfies Payload);
    const s = state(store);
    expect(s.workflow).toBe('txt2img');
    expect(s.ecosystem).toBe('Illustrious');
    expect(s.prompt).toBe('remixed prompt');
    expect(s.quantity).toBe(4); // preserved through reset exclude
    expect((s.model as { id?: number })?.id).toBe(555);
  });

  // `coerce` is read from the resolution that exists BEFORE the patch lands
  // (form-graph `store.js`: `resolution.records.get(key)?.codec?.coerce`), so a single set
  // carrying the discriminators and the values together truncates against the OLD
  // family’s cap. The discriminators have to be staged first or the hook is inert on
  // exactly the path it exists for.
  it('remix: a long prompt is truncated to the TARGET family cap, not the source’s', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'short' });

    applyGenerationData(store, {
      runType: 'remix',
      params: {
        workflow: 'txt2music',
        ecosystem: 'Sonilo',
        prompt: 'x'.repeat(MAX_PROMPT_LENGTH),
      },
      resources: [],
    } satisfies Payload);

    const s = state(store);
    expect(s.ecosystem).toBe('Sonilo');
    expect((s.prompt as string).length).toBe(SONILO_MAX_PROMPT_LENGTH);

    // The point of the truncation: without it the value is stored verbatim and
    // `validate()` refuses it, blocking the submit. The prompt input does render that
    // error, so this one is visible — but the over-length text came from the SOURCE, not
    // from anything the user typed, so making them trim thousands of characters they did
    // not write is the defect.
    const result = store.validate();
    expect(
      result.success,
      `validate must not refuse the ingested value: ${JSON.stringify(
        'errors' in result ? result.errors : {}
      )}`
    ).toBe(true);
  });
  // Append crosses output types, so the cap belongs to the TARGET workflow's resolved
  // ecosystem, not the one on screen. img2model3d resolves to PolyGen, max 1.
  it('append: a cross-output target keeps the NEWEST image, not the first', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });

    applyGenerationData(store, {
      runType: 'append',
      params: {
        workflow: 'img2model3d',
        images: [
          { url: 'https://image.civitai.com/old.png', width: 8, height: 8 },
          { url: 'https://image.civitai.com/new.png', width: 8, height: 8 },
        ],
      },
      resources: [],
    } satisfies Payload);

    const s = state(store);
    expect(s.workflow).toBe('img2model3d');
    const images = s.images as Array<{ url: string }>;
    // Identity, not length: trimming the wrong end keeps the right COUNT and the
    // wrong image, which is the whole failure.
    expect(images.map((i) => i.url)).toEqual(['https://image.civitai.com/new.png']);
  });

  // NEGATIVE CONTROL for the above: under the cap nothing is dropped and the order
  // survives, so the slice is not firing unconditionally.
  it('append: under the target cap, every image survives in order', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });

    applyGenerationData(store, {
      runType: 'append',
      params: {
        workflow: 'img2img:edit',
        images: [
          { url: 'https://image.civitai.com/a.png', width: 8, height: 8 },
          { url: 'https://image.civitai.com/b.png', width: 8, height: 8 },
        ],
      },
      resources: [],
    } satisfies Payload);

    const images = state(store).images as Array<{ url: string }>;
    expect(images.map((i) => i.url)).toEqual([
      'https://image.civitai.com/a.png',
      'https://image.civitai.com/b.png',
    ]);
  });
  it('remix with an unknown workflow infers from the ecosystem', () => {
    const store = makeStore();
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'some:legacy-key', ecosystem: 'SDXL', prompt: 'p' },
      resources: [],
    } satisfies Payload);
    expect(state(store).workflow).toBe('txt2img');
  });

  it('wildcard: adds the set id once, preserving snippets state', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL' });
    store.set({ snippets: { wildcardSetIds: [1], mode: 'batch', batchCount: 3, targets: {} } });
    applyGenerationData(store, {
      runType: 'wildcard',
      params: { wildcardSetId: 2 },
      resources: [],
    } satisfies Payload);
    applyGenerationData(store, {
      runType: 'wildcard',
      params: { wildcardSetId: 2 },
      resources: [],
    } satisfies Payload);
    const snippets = state(store).snippets as { wildcardSetIds: number[]; mode: string };
    expect(snippets.wildcardSetIds).toEqual([1, 2]);
    expect(snippets.mode).toBe('batch');
  });

  it('append: dedups by url against the TARGET workflow bucket, switching to it', () => {
    const img = (url: string) => ({ url, width: 512, height: 512 });
    const store = makeStore({
      workflow: 'txt2img',
      'ecosystem@image': 'SDXL',
      'images@img2img:edit': [img('a')],
    });
    applyGenerationData(store, {
      runType: 'append',
      params: { workflow: 'img2img:edit', images: [img('a'), img('b')] },
      resources: [],
    } satisfies Payload);
    const s = state(store);
    expect(s.workflow).toBe('img2img:edit');
    expect((s.images as { url: string }[]).map((i) => i.url)).toEqual(['a', 'b']);
  });

  it('run: merges resources onto compatible existing, keeping the current ecosystem', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL' });
    store.set({ resources: [{ id: 1, model: { type: 'LORA' }, baseModel: 'SDXL 1.0' }] });
    applyGenerationData(store, {
      runType: 'run',
      params: {},
      resources: [res({ id: 2, model: { type: 'LORA' }, baseModel: 'SDXL 1.0' })],
    } satisfies Payload);
    const s = state(store);
    expect(s.ecosystem).toBe('SDXL');
    expect((s.resources as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2]);
  });
});

describe('append respects the target cap', () => {
  const img = (i: number) => ({
    url: `https://image.civitai.com/x/${i}.jpeg`,
    width: 1024,
    height: 1024,
  });

  // 🔴 KEEPS THE NEWEST. `imagesDef` trims from the FRONT, which is right for a remix and
  // wrong for append: the request comes from a queue item or the 3D viewer, so the image
  // being added IS the user's intent. Trimming the other way discards exactly the one
  // they clicked, which reads as a button that did nothing.
  it('drops the OLDEST image, not the one being appended', () => {
    const store = makeStore();
    store.set({ workflow: 'img2img:edit', ecosystem: 'Qwen', prompt: 'x' });
    const cap = (store.getField('images')?.meta as { max: number }).max;
    const existing = Array.from({ length: cap }, (_, i) => img(i));
    store.set({ images: existing });

    const appended = img(99);
    applyGenerationData(store, {
      runType: 'append',
      params: { workflow: 'img2img:edit', images: [appended] },
      resources: [],
    } as never);

    const images = state(store).images as Array<{ url: string }>;
    expect(images.length).toBe(cap);
    expect(images.map((i) => i.url)).toContain(appended.url);
    expect(images.map((i) => i.url)).not.toContain(existing[0]!.url);
  });

  it('appends normally when the target has room', () => {
    const store = makeStore();
    store.set({ workflow: 'img2img:edit', ecosystem: 'Qwen', prompt: 'x' });
    store.set({ images: [img(0)] });

    applyGenerationData(store, {
      runType: 'append',
      params: { workflow: 'img2img:edit', images: [img(1)] },
      resources: [],
    } as never);

    expect((state(store).images as unknown[]).length).toBe(2);
  });
});

describe('replay null params (QueueItem shape)', () => {
  it('null params are dropped, not written as trusted values that poison validate', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'x' });
    applyGenerationData(store, {
      runType: 'replay',
      params: { workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat', seed: null, images: null },
      resources: [],
    } as never);

    expect(store.getField('seed')?.error).toBeUndefined();
    const result = store.validate();
    expect(result.success).toBe(true);
  });

  // The same sentence as the null case with a different value, and the one the null fix
  // did not generalise to: `ingestion.ts` filters only `value !== null`, so every other
  // out-of-contract value reached state verbatim. Measured in prod before the def-level
  // `correct` hooks landed: 4.4% of media-carrying remixes refused at `validate()`, which
  // the footer surfaces as a Generate button that does nothing.
  //
  // This sits at the INGESTION level deliberately. The def tests drive `store.set`
  // directly, so they cannot see an ingestion path that stops routing through resolution
  // — which is the regression that would bring the dead button back.
  it('out-of-contract remix params are corrected, not left to poison validate', () => {
    const store = makeStore();
    store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'x' });
    const nine = Array.from({ length: 9 }, (_, i) => ({
      url: `https://image.civitai.com/x/${i}.jpeg`,
      width: 1024,
      height: 1024,
    }));
    applyGenerationData(store, {
      runType: 'remix',
      params: {
        workflow: 'img2img:edit',
        ecosystem: 'Qwen',
        prompt: `HEAD${'x'.repeat(6000)}`,
        seed: 9_999_999_999_999,
        images: nine,
      },
      resources: [],
    } as never);

    const result = store.validate();
    expect(
      result.success,
      `a remix must not land unsubmittable: ${JSON.stringify(
        result.success === false ? result.errors : {}
      )}`
    ).toBe(true);

    const s = state(store);
    const max = (store.getField('images')?.meta as { max: number }).max;
    expect((s.images as unknown[]).length).toBe(max);
    expect(s.images).toEqual(nine.slice(0, max));
    expect(s.seed).toBeUndefined();
    expect((s.prompt as string).length).toBe(6000);
    expect((s.prompt as string).startsWith('HEAD')).toBe(true);
  });

  // NEGATIVE CONTROL for the seed drop above. `toBeUndefined()` on its own is also
  // satisfied by ingestion losing `seed` altogether, and nothing else in this file
  // asserts that a usable seed arrives — a remix would silently stop being reproducible.
  it('remix: a reproducible seed survives ingestion', () => {
    const store = makeStore();
    applyGenerationData(store, {
      runType: 'remix',
      params: { workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat', seed: 42 },
      resources: [],
    } satisfies Payload);

    expect(state(store).seed).toBe(42);
  });
});
