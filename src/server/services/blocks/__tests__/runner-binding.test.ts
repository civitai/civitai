import { describe, expect, it } from 'vitest';
import {
  checkRunnerBinding,
  runnerBindingHashes,
  type RunnerBindingBody,
  type RunnerSlot,
} from '~/server/services/blocks/runner-binding';

// Binding v1: the hashes a runner submit must reproduce. The vector is the shared one, and was
// cross-checked against an independent sorted-key JSON + sha256 implementation; a change here
// breaks every stored authorization.

const IMAGE =
  'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/5cd97133-1989-41bd-bdd9-7145e1b5cad6/original=true/in.jpeg';

const inline = (over: { image?: unknown; prompt?: unknown; maxBuzz?: number } = {}) =>
  ({
    kind: 'customComfy',
    mode: 'inline',
    workflow: {
      '1': { class_type: 'LoadImage', inputs: { image: over.image ?? IMAGE } },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { clip: ['3', 0], text: over.prompt ?? 'a cat' },
      },
      '4': { class_type: 'KSampler', inputs: { steps: 20, sampler_name: 'euler' } },
    },
    resources: ['urn:air:sdxl:checkpoint:civitai:1@2'],
    prompt: '',
    negativePrompt: '',
    maxBuzz: 60,
  } as unknown as RunnerBindingBody);

const SLOTS: RunnerSlot[] = [
  { path: '/workflow/1/inputs/image', type: 'image' },
  { path: '/workflow/2/inputs/text', type: 'text' },
];
const COST = { ceiling: 60, resources: ['urn:air:sdxl:checkpoint:civitai:1@2'] };

const hashes = (body = inline(), slots = SLOTS, cost = COST) => {
  const r = runnerBindingHashes(body, slots, cost);
  if (!r.ok) throw new Error(`refused: ${r.refusal}`);
  return r.hashes;
};
const refusal = (body: RunnerBindingBody, slots: RunnerSlot[]) => {
  const r = runnerBindingHashes(body, slots, COST);
  return r.ok ? 'ok' : r.refusal;
};

describe('runner binding v1', () => {
  it('matches the shared test vector', () => {
    expect(hashes()).toEqual({
      recipeVersionHash: 'df44b60ea0901fa3f1f36daa314c8ae9f1a60f05a4c9bc3809f0a1f883179732',
      paramsHash: 'a916d98267c71ae6ebf975497ae547ece21ebbfde1254c5dfaec408fda9b5b09',
    });
  });

  it('does not depend on the slot values or on key order', () => {
    const base = hashes();
    expect(
      hashes(inline({ image: IMAGE.replace('in.jpeg', 'other.png'), prompt: 'a dog' }))
    ).toEqual(base);
    const reordered = JSON.parse(JSON.stringify(inline())) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as RunnerBindingBody;
    expect(hashes(shuffled)).toEqual(base);
  });

  it('changes params_hash for anything outside a slot: the ceiling, the resources, a fixed input', () => {
    const base = hashes();
    expect(hashes(inline(), SLOTS, { ...COST, ceiling: 61 }).paramsHash).not.toBe(base.paramsHash);
    expect(
      hashes(inline(), SLOTS, { ...COST, resources: ['urn:air:sdxl:checkpoint:civitai:1@3'] })
        .paramsHash
    ).not.toBe(base.paramsHash);
    const body = inline() as unknown as {
      workflow: Record<string, { inputs: Record<string, unknown> }>;
    };
    body.workflow['4'].inputs.steps = 21;
    expect(hashes(body as unknown as RunnerBindingBody)).not.toEqual(base);
  });

  it('changes recipe_version_hash when the slot list changes', () => {
    expect(hashes(inline(), SLOTS.slice(0, 1)).recipeVersionHash).not.toBe(
      hashes().recipeVersionHash
    );
  });

  it('refuses an unsorted or duplicated slot list', () => {
    expect(refusal(inline(), [...SLOTS].reverse())).toBe('slots');
    expect(refusal(inline(), [SLOTS[0], SLOTS[0]])).toBe('slots');
  });

  it('refuses a slot on any input outside the allowlist, or of the wrong type', () => {
    for (const path of [
      '/workflow/4/inputs/sampler_name',
      '/workflow/4/inputs/steps',
      '/maxBuzz',
      '/resources/0',
      '/prompt',
      '/workflow/2/inputs',
      '/workflow/9/inputs/text',
    ]) {
      expect(refusal(inline(), [{ path, type: 'text' }]), path).toBe('slot_path');
    }
    expect(refusal(inline(), [{ path: '/workflow/1/inputs/image', type: 'text' }])).toBe(
      'slot_path'
    );
  });

  it('refuses a recipe-arm slot on a param the recipe does not declare', () => {
    const recipe = {
      kind: 'customComfy',
      recipe: 'starter-comfy-txt2img',
      params: { prompt: 'a cat' },
    } as unknown as RunnerBindingBody;
    expect(refusal(recipe, [{ path: '/params/prompt', type: 'text' }])).toBe('slot_path');
  });

  it('refuses a slot value that is not a bounded leaf of its type', () => {
    const text = [{ path: '/workflow/2/inputs/text', type: 'text' as const }];
    const image = [{ path: '/workflow/1/inputs/image', type: 'image' as const }];
    for (const prompt of [{ a: 1 }, ['x'], 7, true, '', 'x'.repeat(4097), 'a\nb']) {
      expect(refusal(inline({ prompt }), text), JSON.stringify(prompt)).toBe('slot_value');
    }
    for (const value of ['urn:air:sdxl:lora:civitai:5@6', 'model.safetensors']) {
      expect(refusal(inline({ prompt: value }), text), value).toBe('slot_value');
    }
    expect(refusal(inline({ image: 'https://evil.example/x.png' }), image)).toBe('slot_value');
    for (const prompt of ['embedding:EasyNegative', 'a cat, (EMBEDDING:bad:1.2)']) {
      expect(refusal(inline({ prompt }), text), prompt).toBe('slot_value');
    }
  });

  it('an image slot takes only an image CDN file, never another civitai URL', () => {
    const image = [{ path: '/workflow/1/inputs/image', type: 'image' as const }];
    expect(refusal(inline(), image)).toBe('ok');
    for (const url of [
      'https://civitai.com/api/download/models/12345',
      'https://image.civitai.com/api/download/models/12345',
      'https://orchestration.civitai.com/v2/consumer/blobs/abc',
      `${IMAGE}?download=1`,
      IMAGE.replace('.jpeg', '.safetensors'),
      IMAGE.replace('https:', 'http:'),
      IMAGE.replace('image.civitai.com', 'image.civitai.com:8443'),
    ]) {
      expect(refusal(inline({ image: url }), image), url).toBe('slot_value');
    }
  });

  it('accepts the authorized hashes and refuses any other, without saying which differed', () => {
    const authorized = hashes();
    expect(checkRunnerBinding(inline({ prompt: 'a dog' }), SLOTS, COST, authorized)).toEqual({
      ok: true,
    });
    for (const wrong of [
      { ...authorized, paramsHash: authorized.recipeVersionHash },
      { ...authorized, recipeVersionHash: authorized.paramsHash },
    ]) {
      expect(checkRunnerBinding(inline(), SLOTS, COST, wrong)).toEqual({
        ok: false,
        refusal: 'mismatch',
      });
    }
  });
});
