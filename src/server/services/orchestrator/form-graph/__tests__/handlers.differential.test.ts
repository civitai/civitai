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
import { createFormGraphStepInput } from '../index';

/**
 * The handler lane's oracle test: the data-graph dispatcher and the
 * form-graph dispatcher are fed the SAME parsed data (the port's, which the
 * 4,700-case parity suite pins as byte-identical to the oracle's) and must
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
  // Enhanced compatibility rewrites textToImage engines in both lanes
  {
    workflow: 'txt2img',
    ecosystem: 'SDXL',
    prompt: 'a cat',
    seed: 42,
    enhancedCompatibility: true,
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
  {
    workflow: 'vid2vid:extend',
    ecosystem: 'LTXV23',
    prompt: 'a cat',
    seed: 42,
    video: VIDEO_INPUT,
    numFrames: 48,
  },
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
  // Seedance
  { workflow: 'txt2vid', ecosystem: 'Seedance', prompt: 'a cat', seed: 42 },
  { workflow: 'img2vid', ecosystem: 'Seedance', prompt: 'a cat', seed: 42, images: [IMAGE] },
];

async function bothLanes(input: Record<string, unknown>) {
  const parsed = generationHub.parse(input, BASE as never);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);
  const data = parsed.data as never;
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
        { ecosystem: 'Flux1', workflow: 'txt2img', prompt: 'x', seed: 1 } as never,
        ctx
      )
    ).rejects.toThrow(/no handler for ecosystem/);
  });
});

// dbMock is imported for its module-level effect (Prisma stub); reference it so
// the import survives organize-imports.
void dbMock;
