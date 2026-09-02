import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import type { GenerationHandlerCtx } from '../../orchestration-new.service';
import type * as FliptClient from '~/server/flipt/client';

// Wan v2.2 routes on this flag; pin it per test so both lanes see one answer.
let wan22MultiStep = false;
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => wan22MultiStep),
}));

import { createEcosystemStepInput } from '../../ecosystems';
import { createFormGraphStepInput, type GenerationData } from '../index';

/**
 * The handler lane's oracle test: the data-graph dispatcher and the
 * form-graph dispatcher are fed the SAME parsed data (the port's, which the
 * image/video parity suites pins as byte-identical to the oracle's) and must
 * emit identical @civitai/client steps. A transcription slip in a form-graph
 * handler fails here with the exact step diff.
 */

const BASE: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const ctx = {
  airs: { getOrThrow: (id: number) => `urn:air:test:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

const IMAGE = { url: 'https://example.com/a.png', width: 1216, height: 832 };
const VIDEO_INPUT = {
  url: 'https://example.com/a.mp4',
  metadata: { fps: 24, width: 1280, height: 720, duration: 5 },
};

/** Every input carries a seed so neither dispatcher reaches its RNG. */
const CASES: Record<string, unknown>[] = [
  // SD family: textToImage, draft batching, comfy (img2img + hires), controlnets
  { workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2img:draft', ecosystem: 'SD1', prompt: 'a cat', seed: 42, quantity: 4 },
  { workflow: 'img2img', ecosystem: 'Pony', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2img:hires-fix', ecosystem: 'Illustrious', prompt: 'a cat', seed: 42 },
  {
    workflow: 'txt2img',
    ecosystem: 'SD1',
    prompt: 'a cat',
    seed: 42,
    resources: [{ id: 111, baseModel: 'SD 1.5', model: { type: 'LORA' }, strength: 0.8 }],
    vae: { id: 333, baseModel: 'SD 1.5', model: { type: 'VAE' } },
    controlNets: [{ preprocessor: 'canny', image: { url: 'https://example.com/cn.png' } }],
  },
  // ZImage: both modes
  { workflow: 'txt2img', ecosystem: 'ZImageTurbo', prompt: 'a cat', seed: 42 },
  {
    workflow: 'txt2img',
    ecosystem: 'ZImageBase',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    sampler: 'heun',
    scheduler: 'discrete',
    seed: 42,
  },
  // Chroma
  { workflow: 'txt2img', ecosystem: 'Chroma', prompt: 'a cat', seed: 42, quantity: 2 },
  // Flux: every mode + the draft coupling in both directions
  { workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2img:draft', ecosystem: 'Flux1', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2img:draft', ecosystem: 'Flux1', prompt: 'a cat', seed: 42, model: 691639 },
  { workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'a cat', seed: 42, model: 699279 },
  { workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'a cat', seed: 42, model: 922358 },
  {
    workflow: 'txt2img',
    ecosystem: 'Flux1',
    prompt: 'a cat',
    seed: 42,
    model: 1088507,
    aspectRatio: '21:9',
    fluxUltraRaw: true,
  },
  { workflow: 'txt2img', ecosystem: 'FluxKrea', prompt: 'a cat', seed: 42 },
  {
    workflow: 'txt2img',
    ecosystem: 'Flux1',
    prompt: 'a cat',
    seed: 42,
    resources: [{ id: 555, baseModel: 'Flux.1 D', model: { type: 'LORA' }, strength: 0.7 }],
  },
  // Enhanced compatibility rewrites textToImage engines in both lanes
  {
    workflow: 'txt2img',
    ecosystem: 'SDXL',
    prompt: 'a cat',
    seed: 42,
    enhancedCompatibility: true,
  },
  // Boogu: version-routed model strings; edit variants carry images
  { workflow: 'txt2img', ecosystem: 'Boogu', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2img', ecosystem: 'Boogu', prompt: 'a cat', seed: 42, model: 3050010 },
  {
    workflow: 'img2img:edit',
    ecosystem: 'Boogu',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    seed: 42,
    images: [IMAGE],
    resources: [{ id: 999, baseModel: 'Boogu', model: { type: 'LORA' }, strength: 0.5 }],
  },
  {
    workflow: 'img2img:edit',
    ecosystem: 'Boogu',
    prompt: 'a cat',
    seed: 42,
    model: 3113427,
    images: [IMAGE],
  },
  // Krea2: FAL tier with style refs, comfy raw/turbo, edit with diffusionModel
  {
    workflow: 'txt2img',
    ecosystem: 'Krea2',
    prompt: 'a cat',
    seed: 42,
    model: 2983023,
    creativity: 'high',
    styleReferences: [{ image: 'https://example.com/s.png', strength: 0.7 }],
  },
  { workflow: 'txt2img', ecosystem: 'Krea2', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2img', ecosystem: 'Krea2', prompt: 'a cat', seed: 42, model: 3072332 },
  { workflow: 'img2img:edit', ecosystem: 'Krea2', prompt: 'a cat', seed: 42, images: [IMAGE] },
  // Imagen4 / PonyV7 / Reve / MAI: single-version fal/google families
  {
    workflow: 'txt2img',
    ecosystem: 'Imagen4',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    seed: 42,
  },
  { workflow: 'txt2img', ecosystem: 'PonyV7', prompt: 'a cat', seed: 42, quantity: 2 },
  { workflow: 'txt2img', ecosystem: 'Reve', prompt: 'a cat', seed: 42, aspectRatio: '16:9' },
  { workflow: 'img2img:edit', ecosystem: 'Reve', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2img', ecosystem: 'MAI', prompt: 'a cat', seed: 42 },
  { workflow: 'img2img:edit', ecosystem: 'MAI', prompt: 'a cat', seed: 42, images: [IMAGE] },
  // Ernie: base with LoRA vs turbo; Seedream: version + resolution tiers
  {
    workflow: 'txt2img',
    ecosystem: 'Ernie',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    seed: 42,
    resources: [{ id: 444, baseModel: 'Ernie', model: { type: 'LORA' }, strength: 0.7 }],
  },
  { workflow: 'txt2img', ecosystem: 'Ernie', prompt: 'a cat', seed: 42, model: 2863892 },
  { workflow: 'txt2img', ecosystem: 'Seedream', prompt: 'a cat', seed: 42 },
  {
    workflow: 'txt2img',
    ecosystem: 'Seedream',
    prompt: 'a cat',
    seed: 42,
    model: 2470991,
    resolution: '2K',
  },
  {
    workflow: 'img2img:edit',
    ecosystem: 'Seedream',
    prompt: 'a cat',
    seed: 42,
    model: 2208174,
    images: [IMAGE],
  },
  // Anima: base with LoRA + controlnet; turbo. MageFlow: all four models
  {
    workflow: 'txt2img',
    ecosystem: 'Anima',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    sampler: 'dpmpp_2m',
    scheduler: 'sgm_uniform',
    seed: 42,
    resources: [{ id: 666, baseModel: 'Anima', model: { type: 'LORA' }, strength: 0.8 }],
    controlNets: [{ preprocessor: 'canny', image: { url: 'https://example.com/cn.png' } }],
  },
  { workflow: 'txt2img', ecosystem: 'Anima', prompt: 'a cat', seed: 42, model: 3108589 },
  { workflow: 'txt2img', ecosystem: 'MageFlow', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2img', ecosystem: 'MageFlow', prompt: 'a cat', seed: 42, model: 3172039 },
  { workflow: 'img2img:edit', ecosystem: 'MageFlow', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'img2img:edit',
    ecosystem: 'MageFlow',
    prompt: 'a cat',
    seed: 42,
    model: 3172044,
    images: [IMAGE],
  },
  // HiDream: full variant with everything; fast bare. O1: dev/full, create/edit
  {
    workflow: 'txt2img',
    ecosystem: 'HiDream',
    prompt: 'a cat',
    seed: 42,
    model: 1772448,
    negativePrompt: 'blurry',
    resources: [{ id: 321, baseModel: 'HiDream', model: { type: 'LORA' }, strength: 0.9 }],
  },
  { workflow: 'txt2img', ecosystem: 'HiDream', prompt: 'a cat', seed: 42, model: 1770945 },
  { workflow: 'txt2img', ecosystem: 'HiDream-O1', prompt: 'a cat', seed: 42 },
  {
    workflow: 'img2img:edit',
    ecosystem: 'HiDream-O1',
    prompt: 'a cat',
    seed: 42,
    model: 2939946,
    images: [IMAGE],
  },
  // OpenAI gpt1 transparency + gpt2; Lens base with LoRA + turbo
  {
    workflow: 'txt2img',
    ecosystem: 'OpenAI',
    prompt: 'a cat',
    seed: 42,
    model: 1733399,
    transparent: true,
    quality: 'low',
  },
  { workflow: 'txt2img', ecosystem: 'OpenAI', prompt: 'a cat', seed: 42, quantity: 3 },
  { workflow: 'img2img:edit', ecosystem: 'OpenAI', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'txt2img',
    ecosystem: 'Lens',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    seed: 42,
    resources: [{ id: 246, baseModel: 'Lens', model: { type: 'LORA' }, strength: 0.4 }],
  },
  { workflow: 'txt2img', ecosystem: 'Lens', prompt: 'a cat', seed: 42, model: 2982241 },
  // Qwen family: sdcpp with LoRA, fal, DashScope + edits
  {
    workflow: 'txt2img',
    ecosystem: 'Qwen',
    prompt: 'a cat',
    seed: 42,
    model: 2110043,
    resources: [{ id: 135, baseModel: 'Qwen', model: { type: 'LORA' }, strength: 0.6 }],
  },
  { workflow: 'img2img:edit', ecosystem: 'Qwen', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2img', ecosystem: 'Qwen2', prompt: 'a cat', negativePrompt: 'blurry', seed: 42 },
  {
    workflow: 'txt2img',
    ecosystem: 'Qwen3',
    prompt: 'a cat',
    seed: 42,
    enablePromptExpansion: false,
  },
  { workflow: 'img2img:edit', ecosystem: 'Qwen3', prompt: 'a cat', seed: 42, images: [IMAGE] },
  // Nano Banana: all four modes + standard edit
  { workflow: 'txt2img', ecosystem: 'NanoBanana', prompt: 'a cat', seed: 42 },
  { workflow: 'img2img:edit', ecosystem: 'NanoBanana', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'txt2img',
    ecosystem: 'NanoBanana',
    prompt: 'a cat',
    seed: 42,
    model: 2436219,
    resolution: '2K',
    aspectRatio: '16:9',
  },
  {
    workflow: 'txt2img',
    ecosystem: 'NanoBanana',
    prompt: 'a cat',
    seed: 42,
    model: 2725610,
    enableWebSearch: true,
  },
  { workflow: 'txt2img', ecosystem: 'NanoBanana', prompt: 'a cat', seed: 42, model: 3086021 },
  // WanImage 2.7: create + edit; Grok: image v1/v2 halves + video ops
  { workflow: 'txt2img', ecosystem: 'WanImage27', prompt: 'a cat', negativePrompt: 'x', seed: 42 },
  {
    workflow: 'img2img:edit',
    ecosystem: 'WanImage27',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE],
    enablePromptEnhancer: true,
  },
  { workflow: 'txt2img', ecosystem: 'Grok', prompt: 'a cat', seed: 42 },
  { workflow: 'img2img:edit', ecosystem: 'Grok', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2vid', ecosystem: 'Grok', prompt: 'a cat', seed: 42, duration: 10 },
  {
    workflow: 'txt2vid',
    ecosystem: 'Grok',
    prompt: 'a cat',
    seed: 42,
    model: 3197990,
    resolution: '1080p',
  },
  { workflow: 'img2vid', ecosystem: 'Grok', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'img2vid:ref2vid',
    ecosystem: 'Grok',
    prompt: 'a cat',
    seed: 42,
    model: 3197990,
    images: [IMAGE],
  },
  { workflow: 'vid2vid:edit', ecosystem: 'Grok', prompt: 'a cat', seed: 42, video: VIDEO_INPUT },
  // Flux Kontext: both modes, img2img with source image
  { workflow: 'txt2img', ecosystem: 'Flux1Kontext', prompt: 'a cat', seed: 42 },
  {
    workflow: 'img2img:edit',
    ecosystem: 'Flux1Kontext',
    prompt: 'a cat',
    seed: 42,
    model: 1892523,
    images: [IMAGE],
    aspectRatio: '21:9',
  },
  // Flux2: dev with LoRA, flex, max, and the editImage operation
  {
    workflow: 'txt2img',
    ecosystem: 'Flux2',
    prompt: 'a cat',
    seed: 42,
    resources: [{ id: 777, baseModel: 'Flux.2 D', model: { type: 'LORA' }, strength: 0.6 }],
  },
  { workflow: 'txt2img', ecosystem: 'Flux2', prompt: 'a cat', seed: 42, model: 2439047 },
  {
    workflow: 'img2img:edit',
    ecosystem: 'Flux2',
    prompt: 'a cat',
    seed: 42,
    model: 2547175,
    images: [IMAGE],
  },
  // Flux2 Klein: distilled pins steps/cfg; base exposes sampler/scheduler; LoRAs everywhere
  { workflow: 'txt2img', ecosystem: 'Flux2Klein_9B', prompt: 'a cat', seed: 42 },
  {
    workflow: 'txt2img',
    ecosystem: 'Flux2Klein_4B_base',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    sampler: 'heun',
    scheduler: 'karras',
    seed: 42,
    resources: [{ id: 888, baseModel: 'Flux.2 Klein 4B', model: { type: 'LORA' }, strength: 0.9 }],
  },
  {
    workflow: 'img2img:edit',
    ecosystem: 'Flux2Klein_9B_base',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE],
  },
  // LTX: all three versions + edit/extend + distilled + prompt enhancer
  { workflow: 'txt2vid', ecosystem: 'LTXV2', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2vid', ecosystem: 'LTXV23', prompt: 'a cat', seed: 42, resolution: '1080p' },
  { workflow: 'img2vid', ecosystem: 'LTXV23', prompt: 'a cat', seed: 42, images: [IMAGE] },
  // vid2vid:edit is not currently routed to LTX (the workflow redirect sends
  // it elsewhere), so the edit path is pinned on wan 2.7 below instead.
  {
    workflow: 'vid2vid:edit',
    ecosystem: 'WanVideo27',
    prompt: 'a cat',
    seed: 42,
    video: VIDEO_INPUT,
  },
  // vid2vid:extend is DISABLED in the workflow config (quality; the graph and
  // handler branches stay for re-enablement) — no case can reach it live
  { workflow: 'txt2vid', ecosystem: 'LTXV25', prompt: 'a cat', seed: 42 },
  {
    workflow: 'txt2vid',
    ecosystem: 'LTXV23',
    prompt: 'a cat',
    seed: 42,
    model: { id: 2749948, baseModel: 'LTXV 2.3' }, // distilled: cfg/steps pinned
  },
  {
    workflow: 'txt2vid',
    ecosystem: 'LTXV23',
    prompt: 'a cat',
    seed: 42,
    enablePromptEnhancer: true,
  },
  // Wan: every version; v2.1 I2V resolution variants; v2.2 legacy fal path
  { workflow: 'txt2vid', ecosystem: 'WanVideo14B_T2V', prompt: 'a cat', seed: 42 },
  {
    workflow: 'img2vid',
    ecosystem: 'WanVideo14B_T2V',
    // wan derives the backend key from workflow+resolution: img2vid on the
    // T2V version parses to the I2V backend — same wan handler, by design
    expectEcosystem: 'WanVideo14B_I2V_480p',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE],
    resolution: '480p',
  },
  { workflow: 'txt2vid', ecosystem: 'WanVideo-22-T2V-A14B', prompt: 'a cat', seed: 42, shift: 10 },
  { workflow: 'txt2vid', ecosystem: 'WanVideo-22-TI2V-5B', prompt: 'a cat', seed: 42, steps: 30 },
  { workflow: 'txt2vid', ecosystem: 'WanVideo-25-T2V', prompt: 'a cat', seed: 42 },
  { workflow: 'txt2vid', ecosystem: 'WanVideo27', prompt: 'a cat', seed: 42 },
  { workflow: 'img2vid', ecosystem: 'WanVideo27', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2vid', ecosystem: 'WanVideo30', prompt: 'a cat', seed: 42, usePrime: true },
  // MiniMax H3: comfy (turbo/loras/frames) + API build; HappyHorse both versions
  {
    workflow: 'txt2vid',
    ecosystem: 'MiniMaxH3',
    prompt: 'a cat',
    seed: 42,
    turbo: true,
    steps: 12,
    resources: [{ id: 987, baseModel: 'MiniMax', model: { type: 'LORA' }, strength: 0.5 }],
  },
  { workflow: 'img2vid', ecosystem: 'MiniMaxH3', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2vid', ecosystem: 'MiniMaxH3', prompt: 'a cat', seed: 42, model: 3183239 },
  {
    workflow: 'img2vid:ref2vid',
    ecosystem: 'MiniMaxH3',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE],
  },
  { workflow: 'txt2vid', ecosystem: 'HappyHorse', prompt: 'a cat', seed: 42, resolution: '1080p' },
  { workflow: 'img2vid', ecosystem: 'HappyHorse', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'txt2vid', ecosystem: 'HappyHorse', prompt: 'a cat', seed: 42, model: 2902378 },
  {
    workflow: 'vid2vid:edit',
    ecosystem: 'HappyHorse',
    prompt: 'a cat',
    seed: 42,
    model: 2902378,
    video: VIDEO_INPUT,
    images: [IMAGE],
    audioSetting: 'origin',
  },
  // Sora2 / HyV1 / Flux3Video (Mochi supports no live workflows)
  { workflow: 'txt2vid', ecosystem: 'Sora2', prompt: 'a cat', seed: 42, usePro: true, duration: 8 },
  { workflow: 'img2vid', ecosystem: 'Sora2', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'txt2vid',
    ecosystem: 'HyV1',
    prompt: 'a cat',
    seed: 42,
    resources: [{ id: 654, baseModel: 'Hunyuan Video', model: { type: 'LORA' }, strength: 0.7 }],
  },
  { workflow: 'txt2vid', ecosystem: 'Flux3Video', prompt: 'a cat', seed: 42, generateAudio: true },
  {
    workflow: 'txt2vid',
    ecosystem: 'Flux3Video',
    prompt: 'a cat',
    seed: 42,
    draft: true,
    resolution: '1080p',
  },
  {
    workflow: 'img2vid',
    ecosystem: 'Flux3Video',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE, { url: 'https://example.com/b.png', width: 1216, height: 832 }],
  },
  // Seedance
  { workflow: 'txt2vid', ecosystem: 'Seedance', prompt: 'a cat', seed: 42 },
  { workflow: 'img2vid', ecosystem: 'Seedance', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'img2vid:ref2vid',
    ecosystem: 'Seedance',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE, { url: 'https://example.com/b.png', width: 1216, height: 832 }],
  },
  // Veo3: fast vs standard, ref2vid placeholder prompt
  { workflow: 'txt2vid', ecosystem: 'Veo3', prompt: 'a cat', seed: 42, generateAudio: true },
  { workflow: 'txt2vid', ecosystem: 'Veo3', prompt: 'a cat', seed: 42, model: 2827945 },
  { workflow: 'img2vid', ecosystem: 'Veo3', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'img2vid:ref2vid', ecosystem: 'Veo3', prompt: '', seed: 42, images: [IMAGE] },
  // Vidu: Q1 engine vs Q3 engine
  { workflow: 'txt2vid', ecosystem: 'Vidu', prompt: 'a cat', seed: 42, style: 'anime' },
  { workflow: 'img2vid', ecosystem: 'Vidu', prompt: 'a cat', seed: 42, images: [IMAGE] },
  { workflow: 'img2vid:ref2vid', ecosystem: 'Vidu', prompt: '', seed: 42, images: [IMAGE] },
  {
    workflow: 'txt2vid',
    ecosystem: 'Vidu',
    prompt: 'a cat',
    seed: 42,
    model: 2741273,
    resolution: '1080p',
    draft: true,
    enableAudio: true,
  },
  // Kling: legacy engine (v1.6 mode field, string durations) vs kling-v3
  { workflow: 'txt2vid', ecosystem: 'Kling', prompt: 'a cat', seed: 42, duration: '10' },
  {
    workflow: 'txt2vid',
    ecosystem: 'Kling',
    prompt: 'a cat',
    seed: 42,
    model: 2623815,
    mode: 'professional',
    negativePrompt: 'blurry',
  },
  { workflow: 'img2vid', ecosystem: 'Kling', prompt: 'a cat', seed: 42, images: [IMAGE] },
  {
    workflow: 'txt2vid',
    ecosystem: 'Kling',
    prompt: 'a cat',
    seed: 42,
    model: 2698632,
    duration: 12,
    generateAudio: true,
  },
  {
    workflow: 'img2vid',
    ecosystem: 'Kling',
    prompt: 'a cat',
    seed: 42,
    model: 2698632,
    images: [IMAGE, { url: 'https://example.com/b.png', width: 1216, height: 832 }],
  },
  {
    workflow: 'img2vid:ref2vid',
    ecosystem: 'Kling',
    prompt: 'a cat',
    seed: 42,
    images: [IMAGE],
  },
];

async function bothLanes({ expectEcosystem, ...input }: Record<string, unknown>) {
  const parsed = generationHub.parse(input, BASE);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);
  // a hub redirect (unsupported workflow x ecosystem) would silently route the
  // case to a DIFFERENT family's handler and the comparison would be vacuous
  const parsedEco = (parsed.data as { ecosystem?: string }).ecosystem;
  if (parsedEco !== (expectEcosystem ?? input.ecosystem)) {
    throw new Error(
      `case labeled ${String(input.ecosystem)} parsed to ${String(
        parsedEco
      )} — redirected, not testing the named handler`
    );
  }
  const data = parsed.data as GenerationData;
  const v1 = await createEcosystemStepInput(data, ctx);
  const v2 = await createFormGraphStepInput(data, ctx);
  return { v1, v2 };
}

describe('form-graph handlers emit the same steps as the data-graph handlers', () => {
  it.each(CASES.map((input) => ({ name: `${input.workflow} | ${input.ecosystem}`, input })))(
    '$name',
    async ({ input }) => {
      const { v1, v2 } = await bothLanes(input);
      expect(v2).toEqual(v1);
      expect(v2.length).toBeGreaterThan(0);
    }
  );

  it('wan v2.2 multi-step path (flipt on): videoGen + interpolation, both lanes', async () => {
    wan22MultiStep = true;
    try {
      const { v1, v2 } = await bothLanes({
        workflow: 'txt2vid',
        ecosystem: 'WanVideo-22-T2V-A14B',
        prompt: 'a cat',
        seed: 42,
        shift: 10,
      });
      expect(v2).toEqual(v1);
      expect(v2.map((s) => s.$type)).toEqual(['videoGen', 'videoInterpolation']);
    } finally {
      wan22MultiStep = false;
    }
  });

  it('an unported ecosystem is a loud error, not a silent fallthrough', async () => {
    await expect(
      createFormGraphStepInput(
        { ecosystem: 'Ace', workflow: 'txt2music', prompt: 'x', seed: 1 } as GenerationData,
        ctx
      )
    ).rejects.toThrow(/no handler for ecosystem/);
  });
});

// dbMock is imported for its module-level effect (Prisma stub); reference it so
// the import survives organize-imports.
void dbMock;
