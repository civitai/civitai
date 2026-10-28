import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GenerationHandlerCtx, GenerationData } from '../../orchestration-new.service';
import type * as FliptClient from '~/server/flipt/client';

// Wan v2.2 routes on this flag; pinned per test so the arm is deterministic.
let wan22MultiStep = false;
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => wan22MultiStep),
}));

import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import { flux3VideoVersionIds, klingVersionIds } from '~/shared/generation/version-ids';
import { createFlux3VideoInput } from '../flux3-video.handler';
import { createKlingInput } from '../kling.handler';
import { createFormGraphStepInput } from '../index';
import { createOpenAIInput } from '../openai.handler';

/**
 * What each handler actually puts on the wire, asserted absolutely.
 *
 * These assertions were written against `createEcosystemStepInput` as an oracle: the two
 * dispatchers were fed the same parsed data and had to emit identical steps. The oracle is
 * gone with the data-graph lane, and a differential has no meaning with one lane — but the
 * ABSOLUTE half never depended on it. The deleted suite said so itself: "`expect(v2)
 * .toEqual(v1)` is invariant under an edit applied to BOTH lanes, so every payload below
 * needs an absolute assertion or a revert stays green." Those are the assertions, kept
 * verbatim and re-pointed at the surviving dispatcher.
 *
 * Flux.3 and Ideogram 4.5 are the reason this file exists rather than being folded into
 * `form-graph-step-input.test.ts`: both launched within a day of the lane removal, both put
 * all their coverage here, and `ideogram.handler.ts` forks fal-vs-comfy on a VERSION ID —
 * which model runs and what it costs turns on that fork, with nothing else red if it flips.
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
const IMAGE2 = { url: 'https://example.com/b.png', width: 1216, height: 832 };

/**
 * Parse through the hub, then dispatch — with both guards the oracle version carried.
 *
 * They are not ceremony. A hub redirect (an unsupported workflow x ecosystem) routes the
 * case to a DIFFERENT family's handler, and `migrateWorkflowKey` coerces a retired workflow
 * key to `txt2img` with no note. Either one silently turns an assertion about Flux.3 into an
 * assertion about whatever answered instead, which still passes.
 */
async function dispatch({
  expectEcosystem,
  expectWorkflow,
  expectFlags,
  ...input
}: Record<string, unknown>) {
  const ext = expectFlags
    ? { ...BASE, flags: { ...BASE.flags, ...(expectFlags as object) } as GenerationCtx['flags'] }
    : BASE;
  const parsed = generationHub.parse(input, ext);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);

  const parsedEco = (parsed.data as { ecosystem?: string }).ecosystem;
  if (parsedEco !== (expectEcosystem ?? input.ecosystem))
    throw new Error(
      `case labeled ${String(input.ecosystem)} parsed to ${String(
        parsedEco
      )} — redirected, not testing the named handler`
    );

  const parsedWorkflow = (parsed.data as { workflow?: string }).workflow;
  if (parsedWorkflow !== (expectWorkflow ?? input.workflow))
    throw new Error(
      `case labeled ${String(input.workflow)} parsed to ${String(
        parsedWorkflow
      )} — a migrated or retired workflow key, not testing the named workflow`
    );

  return createFormGraphStepInput(parsed.data as GenerationData, ctx);
}

const firstInput = (steps: unknown[]) => (steps[0] as { input: unknown }).input;

describe('flux3.handler', () => {
  it('create reaches fal with resolution and aspect ratio intact', async () => {
    const create = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Flux3',
      prompt: 'a cat',
      resolution: '2k',
      aspectRatio: '16:9',
    });
    expect(firstInput(create)).toMatchObject({
      engine: 'fal',
      model: 'flux3',
      operation: 'createImage',
      resolution: '2k',
      aspectRatio: '16:9',
      enhancePrompt: false,
    });
  });

  // Both directions: the default-off above is satisfiable by a handler that never sends
  // the key at all.
  it('passes prompt expansion through when it is on', async () => {
    const expanded = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Flux3',
      prompt: 'a cat',
      enablePromptExpansion: true,
    });
    expect(firstInput(expanded)).toMatchObject({ enhancePrompt: true });
  });

  it('edit switches operation, forces aspectRatio auto, and keeps image order', async () => {
    const edit = await dispatch({
      workflow: 'img2img:edit',
      ecosystem: 'Flux3',
      prompt: 'a cat',
      images: [IMAGE, IMAGE2],
    });
    expect(firstInput(edit)).toMatchObject({
      engine: 'fal',
      model: 'flux3',
      operation: 'editImage',
      aspectRatio: 'auto',
      resolution: '1k',
      images: [IMAGE.url, IMAGE2.url],
    });
  });
});

describe('flux3-video.handler', () => {
  const V3 = flux3VideoVersionIds['v3.0'];
  const MAX = flux3VideoVersionIds['v3.0-max'];

  it('v3.0 still sends first/last frames as firstLastFrameToVideo', async () => {
    const steps = await dispatch({
      workflow: 'img2vid:first-last',
      ecosystem: 'Flux3Video',
      model: { id: V3 },
      prompt: 'a cat',
      images: [IMAGE, IMAGE2],
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'flux',
      version: 'v3.0',
      operation: 'firstLastFrameToVideo',
      startImage: IMAGE.url,
      endImage: IMAGE2.url,
      aspectRatio: 'auto',
    });
    expect(firstInput(steps)).not.toHaveProperty('reasoningLevel');
  });

  it('Max text-to-video carries the ratio, reasoning level and audio default', async () => {
    const steps = await dispatch({
      workflow: 'txt2vid',
      ecosystem: 'Flux3Video',
      model: { id: MAX },
      prompt: 'a cat',
      aspectRatio: '9:16',
      resolution: '1080p',
      duration: 8,
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'flux',
      version: 'v3.0-max',
      operation: 'textToVideo',
      aspectRatio: '9:16',
      resolution: '1080p',
      duration: 8,
      reasoningLevel: 'high',
      generateAudio: true,
    });
    expect(firstInput(steps)).not.toHaveProperty('draft');
  });

  it('Max image-to-video takes the end frame on the same operation', async () => {
    const steps = await dispatch({
      workflow: 'img2vid:first-last',
      ecosystem: 'Flux3Video',
      model: { id: MAX },
      prompt: 'a cat',
      images: [IMAGE, IMAGE2],
      reasoningLevel: 'low',
    });
    expect(firstInput(steps)).toMatchObject({
      version: 'v3.0-max',
      operation: 'imageToVideo',
      image: IMAGE.url,
      endImage: IMAGE2.url,
      aspectRatio: 'auto',
      reasoningLevel: 'low',
    });
  });

  it('Max image-to-video with one image sends no end frame, and passes audio off and the seed', async () => {
    const steps = await dispatch({
      workflow: 'img2vid',
      ecosystem: 'Flux3Video',
      model: { id: MAX },
      prompt: 'a cat',
      images: [IMAGE],
      generateAudio: false,
      seed: 42,
    });
    expect(firstInput(steps)).toMatchObject({
      operation: 'imageToVideo',
      image: IMAGE.url,
      generateAudio: false,
      seed: 42,
    });
    expect(firstInput(steps)).not.toHaveProperty('endImage');
  });

  it('refuses keyframes when the picker has swapped Max away, rather than sending a v3.0 text-to-video', () => {
    const data = {
      workflow: 'img2vid:keyframes',
      ecosystem: 'Flux3Video',
      flux3VideoVersion: 'v3',
      model: { id: V3, model: { type: 'Checkpoint' } },
      prompt: 'a cat',
      duration: 5,
      resolution: '720p',
      generateAudio: false,
      draft: false,
    } as never;

    expect(() => createFlux3VideoInput(data, ctx)).toThrow(/Max/);
  });

  it('keyframes picked with v3.0 selected go out on Max, in frame order as url + frameIndex pairs', async () => {
    const steps = await dispatch({
      workflow: 'img2vid:keyframes',
      ecosystem: 'Flux3Video',
      model: { id: V3 },
      prompt: 'a cat',
      duration: 5,
      keyframes: [
        { image: IMAGE, frameIndex: 96 },
        { image: IMAGE2, frameIndex: 0 },
      ],
    });
    expect(firstInput(steps)).toMatchObject({
      version: 'v3.0-max',
      operation: 'keyframesToVideo',
      aspectRatio: 'auto',
      keyframes: [
        { image: IMAGE2.url, frameIndex: 0 },
        { image: IMAGE.url, frameIndex: 96 },
      ],
    });
    expect(firstInput(steps)).not.toHaveProperty('images');
  });
});

describe('kling.handler v4', () => {
  const V4 = klingVersionIds.v4;
  const VIDEO = { url: 'https://example.com/a.mp4' };

  it('text-to-video carries the ratio, resolution and duration on kling-v4', async () => {
    const steps = await dispatch({
      workflow: 'txt2vid',
      ecosystem: 'Kling',
      model: { id: V4 },
      prompt: 'a cat',
      aspectRatio: '21:9',
      resolution: '1080p',
      duration: 12,
    });
    expect(firstInput(steps)).toEqual({
      engine: 'kling-v4',
      operation: 'textToVideo',
      prompt: 'a cat',
      aspectRatio: '21:9',
      resolution: '1080p',
      duration: 12,
    });
  });

  it('multi-shot prompts replace the prompt text and the duration', async () => {
    const steps = await dispatch({
      workflow: 'txt2vid',
      ecosystem: 'Kling',
      model: { id: V4 },
      duration: 12,
      multiShot: [
        { prompt: 'a cat wakes up', duration: 2 },
        { prompt: 'the cat jumps', duration: 3 },
      ],
    });
    const input = firstInput(steps);
    expect(input).toMatchObject({
      operation: 'textToVideo',
      multiPrompt: [
        { prompt: 'a cat wakes up', duration: 2 },
        { prompt: 'the cat jumps', duration: 3 },
      ],
    });
    expect(input).toHaveProperty('prompt', '');
    expect(input).not.toHaveProperty('duration');
  });

  // The server resolves img2vid:first-last to img2vid before it parses.
  it('start and end frames go out as keyframes, with middle frames between them', async () => {
    const steps = await dispatch({
      workflow: 'img2vid',
      ecosystem: 'Kling',
      model: { id: V4 },
      prompt: 'a cat',
      images: [IMAGE, IMAGE2],
      middleImages: [IMAGE2],
    });
    const input = firstInput(steps);
    expect(input).toMatchObject({
      operation: 'imageToVideo',
      sourceImage: IMAGE.url,
      endImage: IMAGE2.url,
      middleImages: [IMAGE2.url],
    });
    expect(input).not.toHaveProperty('images');
    expect(input).not.toHaveProperty('aspectRatio');
  });

  it('reference-to-video sends images, videos, elements and voices', async () => {
    const steps = await dispatch({
      workflow: 'img2vid:ref2vid',
      ecosystem: 'Kling',
      model: { id: V4 },
      prompt: 'a cat',
      images: [IMAGE],
      referenceVideos: [VIDEO],
      klingElements: [
        { images: [IMAGE, IMAGE2], voiceId: 'voice-a' },
        { images: [], video: VIDEO },
      ],
      voiceIds: ['voice-b'],
    });
    expect(firstInput(steps)).toMatchObject({
      operation: 'referenceToVideo',
      images: [IMAGE.url],
      videos: [VIDEO.url],
      elements: [
        { frontalImage: IMAGE.url, referenceImages: [IMAGE2.url], voiceId: 'voice-a' },
        { videoUrl: VIDEO.url },
      ],
      voiceIds: ['voice-b'],
    });
  });

  it('refuses a fourth voice counted across elements and voice IDs', () => {
    const parsed = generationHub.parse(
      {
        workflow: 'img2vid:ref2vid',
        ecosystem: 'Kling',
        model: { id: V4 },
        prompt: 'a cat',
        klingElements: [{ images: [IMAGE, IMAGE2], voiceId: 'voice-a' }],
        voiceIds: ['voice-b', 'voice-c', 'voice-d'],
      },
      BASE
    );
    expect(parsed.success).toBe(false);
  });

  it('an edit follows the source length, and a V3 pick on the edit workflow goes out on V4', async () => {
    const steps = await dispatch({
      workflow: 'vid2vid:edit',
      ecosystem: 'Kling',
      model: { id: klingVersionIds.v3 },
      prompt: 'make it night',
      video: VIDEO,
      duration: 12,
    });
    const input = firstInput(steps);
    expect(input).toMatchObject({
      engine: 'kling-v4',
      operation: 'videoToVideoEdit',
      videoUrl: VIDEO.url,
    });
    expect(input).not.toHaveProperty('duration');
    expect(input).not.toHaveProperty('multiPrompt');
  });

  it('refuses an edit when the picker has swapped V4 away, rather than sending another version', () => {
    const data = {
      workflow: 'vid2vid:edit',
      ecosystem: 'Kling',
      klingVersion: 'v3',
      model: { id: klingVersionIds.v3, model: { type: 'Checkpoint' } },
      prompt: 'make it night',
    } as never;

    expect(() => createKlingInput(data, ctx)).toThrow(/V4/);
  });
});

describe('krea3.handler', () => {
  it('create sends ratio, resolution and thinking mode with no images', async () => {
    const create = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      resolution: '2k',
      aspectRatio: '16:9',
      thinkingMode: 'medium',
      images: [IMAGE],
    });
    expect(firstInput(create)).toEqual({
      engine: 'krea3',
      prompt: 'a cat',
      quantity: 1,
      resolution: '2k',
      aspectRatio: '16:9',
      thinkingMode: 'medium',
      images: [],
    });
  });

  it('edit omits the ratio so Krea follows the references, and keeps image order', async () => {
    const edit = await dispatch({
      workflow: 'img2img:edit',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      aspectRatio: '16:9',
      images: [IMAGE, IMAGE2],
    });
    const input = firstInput(edit) as Record<string, unknown>;
    expect(input).toMatchObject({
      engine: 'krea3',
      resolution: '1k',
      thinkingMode: 'instant',
      images: [IMAGE.url, IMAGE2.url],
    });
    expect(input).not.toHaveProperty('aspectRatio');
  });

  it('falls back to the defaults for a resolution or thinking mode Krea 3 does not offer', async () => {
    const create = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      resolution: '4k',
      thinkingMode: 'high',
    });
    expect(firstInput(create)).toMatchObject({ resolution: '1k', thinkingMode: 'instant' });
  });

  it('sends Ultra only when krea3Ultra is on', async () => {
    const on = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      resolution: '2k',
      thinkingMode: 'ultra',
      expectFlags: { krea3Ultra: true },
    });
    expect(firstInput(on)).toMatchObject({ thinkingMode: 'ultra' });

    const off = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      resolution: '2k',
      thinkingMode: 'ultra',
    });
    expect(firstInput(off)).toMatchObject({ thinkingMode: 'instant' });
  });

  // The orchestrator refuses Ultra at 1K ("Ultra is only available at 2K"), and 1K is the default.
  it('sends Ultra only at 2K, falling back to instant at 1K', async () => {
    const at2k = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      resolution: '2k',
      thinkingMode: 'ultra',
      expectFlags: { krea3Ultra: true },
    });
    expect(firstInput(at2k)).toMatchObject({ resolution: '2k', thinkingMode: 'ultra' });

    const at1k = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Krea3',
      prompt: 'a cat',
      resolution: '1k',
      thinkingMode: 'ultra',
      expectFlags: { krea3Ultra: true },
    });
    expect(firstInput(at1k)).toMatchObject({ resolution: '1k', thinkingMode: 'instant' });
  });
});

describe('ideogram.handler', () => {
  // The fork is on the version id, so these two cases are the contract: 4.5 is a fal API
  // model, 4.0 runs on our own comfy. Getting it backwards bills the wrong provider.
  it('4.5 routes to fal with its own resolution and quality', async () => {
    const v45 = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Ideogram',
      prompt: 'a cat',
      seed: 42,
      model: 3375798,
      aspectRatio: '16:9',
      quality: 'high',
    });
    expect(firstInput(v45)).toMatchObject({
      engine: 'fal',
      model: 'ideogram45',
      operation: 'createImage',
      width: 2560,
      height: 1440,
      quality: 'high',
      enhancePrompt: false,
    });
  });

  it('4.0 stays on comfy', async () => {
    const v40 = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Ideogram',
      prompt: 'a cat',
      seed: 42,
    });
    expect(firstInput(v40)).toMatchObject({ engine: 'comfy', ecosystem: 'ideogram4' });
  });

  it('edit sends imageSize auto and keeps image order', async () => {
    const edit = await dispatch({
      workflow: 'img2img:edit',
      ecosystem: 'Ideogram',
      prompt: 'a cat',
      seed: 42,
      images: [IMAGE, IMAGE2],
    });
    expect(firstInput(edit)).toMatchObject({
      engine: 'fal',
      operation: 'editImage',
      imageSize: 'auto',
      images: [IMAGE.url, IMAGE2.url],
    });
  });
});

describe('hunyuan.handler', () => {
  // Unnamed, the orchestrator ran its own default build, so coverage on the site's default
  // decided nothing: every submit failed once that build lost coverage.
  it('names the ecosystem default model', async () => {
    const steps = await dispatch({ workflow: 'txt2vid', ecosystem: 'HyV1', prompt: 'a cat' });
    expect(firstInput(steps)).toMatchObject({
      engine: 'hunyuan',
      checkpointModel: 'urn:air:test:1313562',
    });
  });

  it('a saved fp8 selection still submits the default', async () => {
    const steps = await dispatch({
      workflow: 'txt2vid',
      ecosystem: 'HyV1',
      prompt: 'a cat',
      model: 1314512,
    });
    expect(firstInput(steps)).toMatchObject({ checkpointModel: 'urn:air:test:1313562' });
  });
});

describe('wan.handler v2.1', () => {
  // Unnamed, text-to-video ran the orchestrator's 1.3B default, which is not enabled, so every
  // submit was refused; image-to-video's unnamed default only happened to be enabled.
  it('names the 14B text-to-video model', async () => {
    const steps = await dispatch({
      workflow: 'txt2vid',
      ecosystem: 'WanVideo14B_T2V',
      prompt: 'a cat',
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'wan',
      version: 'v2.1',
      diffusionModel: 'urn:air:test:1707796',
    });
  });

  it('names the 720p image-to-video model', async () => {
    const steps = await dispatch({
      workflow: 'img2vid',
      ecosystem: 'WanVideo14B_I2V_720p',
      prompt: 'a cat',
      resolution: '720p',
      images: [IMAGE],
    });
    expect(firstInput(steps)).toMatchObject({ diffusionModel: 'urn:air:test:1501344' });
  });

  it('names the 480p image-to-video model', async () => {
    const steps = await dispatch({
      workflow: 'img2vid',
      ecosystem: 'WanVideo14B_I2V_480p',
      prompt: 'a cat',
      resolution: '480p',
      images: [IMAGE],
    });
    expect(firstInput(steps)).toMatchObject({ diffusionModel: 'urn:air:test:1501125' });
  });
});

describe('wan-image.handler', () => {
  // The input has no aspect ratio field: an unmapped pick lands on its square default.
  it('sends the picked aspect ratio as a fal size preset', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'WanImage27',
      prompt: 'a cat',
      aspectRatio: '16:9',
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'wan',
      version: 'v2.7',
      operation: 'createImage',
      imageSize: 'landscape_16_9',
    });
  });

  it('edit sends no size, since the ratio picker is hidden there', async () => {
    const steps = await dispatch({
      workflow: 'img2img:edit',
      ecosystem: 'WanImage27',
      prompt: 'a cat',
      images: [IMAGE],
    });
    const input = firstInput(steps) as Record<string, unknown>;
    expect(input).toMatchObject({ operation: 'editImage', images: [IMAGE.url] });
    expect(input.imageSize).toBeUndefined();
  });
});

describe('flux3-klein.handler', () => {
  it('the distilled model sends no steps, cfg or negative prompt', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Flux3Klein',
      prompt: 'a cat',
      negativePrompt: 'blurry',
    });
    const input = firstInput(steps) as Record<string, unknown>;
    expect(input).toMatchObject({
      engine: 'comfy',
      ecosystem: 'flux3Klein',
      model: 'distilled',
      operation: 'createImage',
    });
    expect(input.steps).toBeUndefined();
    expect(input.cfgScale).toBeUndefined();
    expect(input.negativePrompt).toBeUndefined();
    expect(input.images).toBeUndefined();
  });

  it('base sends its steps, cfg and negative prompt', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Flux3Klein_base',
      prompt: 'a cat',
      negativePrompt: 'blurry',
      steps: 40,
      cfgScale: 4,
    });
    expect(firstInput(steps)).toMatchObject({
      model: 'base',
      steps: 40,
      cfgScale: 4,
      negativePrompt: 'blurry',
    });
  });

  it('reference images make it an edit', async () => {
    const steps = await dispatch({
      workflow: 'img2img:edit',
      ecosystem: 'Flux3Klein',
      prompt: 'a cat',
      images: [IMAGE, IMAGE2],
    });
    expect(firstInput(steps)).toMatchObject({
      operation: 'editImage',
      images: [IMAGE.url, IMAGE2.url],
    });
  });
});

describe('moss-image.handler', () => {
  it('SFT pins its whole imageGen payload', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'MossImage',
      prompt: 'a cat',
      negativePrompt: 'blurry',
      aspectRatio: '16:9',
      steps: 40,
      cfgScale: 4,
      seed: 42,
      quantity: 2,
      resources: [{ id: 111, baseModel: 'MOSS Image', model: { type: 'LORA' }, strength: 0.8 }],
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'comfy',
      ecosystem: 'mossImage',
      model: 'sft',
      operation: 'createImage',
      negativePrompt: 'blurry',
      width: 1344,
      height: 768,
      steps: 40,
      cfgScale: 4,
      seed: 42,
      quantity: 2,
    });
    expect((firstInput(steps) as { loras?: unknown }).loras).toEqual({ 'urn:air:test:111': 0.8 });
    expect(firstInput(steps)).not.toHaveProperty('diffusionModel');
  });

  it('a creator checkpoint reaches the orchestrator as diffusionModel', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'MossImage',
      prompt: 'a cat',
      model: { id: 424242, baseModel: 'MOSS Image', model: { type: 'Checkpoint' } },
    });
    expect(firstInput(steps)).toMatchObject({
      ecosystem: 'mossImage',
      model: 'sft',
      diffusionModel: 'urn:air:test:424242',
    });
  });

  // Turbo (DMD) LoRAs run at 8 steps, CFG 1; the floor sits below that for 4-step distills.
  it.each([8, 4])('SFT with a turbo LoRA reaches the orchestrator at %i steps', async (n) => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'MossImage',
      prompt: 'a cat',
      steps: n,
      cfgScale: 1,
      resources: [{ id: 111, baseModel: 'MOSS Image', model: { type: 'LORA' }, strength: 1 }],
    });
    expect(firstInput(steps)).toMatchObject({ model: 'sft', steps: n, cfgScale: 1 });
  });

  it('the Base version selects the base model and keeps the graph defaults', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'MossImage',
      model: { id: 3409868, baseModel: 'MOSS Image' },
      prompt: 'a cat',
    });
    expect(firstInput(steps)).toMatchObject({
      ecosystem: 'mossImage',
      model: 'base',
      steps: 25,
      cfgScale: 3,
    });
    expect(firstInput(steps)).not.toHaveProperty('diffusionModel');
  });
});

describe('the dispatcher itself', () => {
  // A new family added without a case arm must not fall through to whatever the switch
  // ends on. This string is the only thing standing between that and a silent mis-route.
  it('an unknown ecosystem is a loud error, not a silent fallthrough', async () => {
    await expect(
      createFormGraphStepInput(
        {
          workflow: 'txt2img',
          ecosystem: 'NotAnEcosystem',
          prompt: 'a cat',
          seed: 42,
        } as unknown as GenerationData,
        ctx
      )
    ).rejects.toThrow(/no handler for ecosystem/);
  });
});

/**
 * Payload assertions ported from the same deleted suite. Engine SELECTION is already covered
 * by `orchestrator/__tests__/form-graph-step-input.test.ts`; what that file does not pin is
 * what each handler actually puts in the step — the mapped literals, the lora shape, which
 * keys are deliberately absent. Those were the absolute half of the differential and they
 * outlive it.
 */
describe('the imageGen handlers pin their payloads, not just their engine', () => {
  it('flux ultra carries its aspect-ratio label and raw flag', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Flux1',
      prompt: 'a cat',
      seed: 42,
      model: 1088507,
      aspectRatio: '21:9',
      fluxUltraRaw: true,
    });
    expect(firstInput(steps)).toMatchObject({ model: 'ultra', aspectRatio: '21:9', raw: true });
  });

  it('the sdcpp route carries textual inversions as embeddings', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'SD1',
      prompt: 'a cat',
      seed: 42,
      resources: [
        { id: 111, baseModel: 'SD 1.5', model: { type: 'LORA' }, strength: 0.8 },
        { id: 222, baseModel: 'SD 1.5', model: { type: 'TextualInversion' }, strength: 1 },
      ],
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'sdcpp',
      embeddings: ['urn:air:test:222'],
      loras: { 'urn:air:test:111': 0.8 },
    });
  });

  it('chroma pins its whole imageGen payload', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Chroma',
      prompt: 'a cat',
      seed: 42,
      quantity: 2,
      resources: [{ id: 111, baseModel: 'Chroma', model: { type: 'LORA' }, strength: 0.8 }],
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'comfy',
      ecosystem: 'chroma',
      operation: 'createImage',
      // the graph always supplies these, so the handler's own fallbacks never fire
      steps: 25,
      cfgScale: 3.5,
      quantity: 2,
    });
    // toEqual, not toMatchObject: a subset match would not see an extra key appear here
    expect((firstInput(steps) as { loras?: unknown }).loras).toEqual({ 'urn:air:test:111': 0.8 });
  });

  it('chroma drops a textual inversion rather than sending it as a lora', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Chroma',
      prompt: 'a cat',
      seed: 42,
      resources: [
        { id: 111, baseModel: 'Chroma', model: { type: 'LORA' }, strength: 0.8 },
        { id: 222, baseModel: 'Chroma', model: { type: 'TextualInversion' }, strength: 1 },
      ],
    });
    expect((firstInput(steps) as { loras?: unknown }).loras).toEqual({ 'urn:air:test:111': 0.8 });
    expect(firstInput(steps)).not.toHaveProperty('embeddings');
  });

  it('hidream sends its loras', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'HiDream',
      prompt: 'a cat',
      seed: 42,
      model: 1772448,
      resources: [{ id: 321, baseModel: 'HiDream', model: { type: 'LORA' }, strength: 0.9 }],
    });
    expect((firstInput(steps) as { loras?: unknown }).loras).toEqual({ 'urn:air:test:321': 0.9 });
  });

  it('hidream sends variant and precision instead of a checkpoint AIR', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'HiDream',
      prompt: 'a cat',
      seed: 42,
      model: 1768731,
    });
    expect(firstInput(steps)).toMatchObject({ variant: 'fast', precision: 'fp16' });
    expect(firstInput(steps)).not.toHaveProperty('model');
  });

  it('sdxl carries clipSkip', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'SDXL',
      prompt: 'a cat',
      seed: 42,
      clipSkip: 3,
    });
    expect(firstInput(steps)).toMatchObject({ ecosystem: 'sdxl', clipSkip: 3 });
  });

  it('a textual inversion rides the comfy route, which carries embeddings', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'SDXL',
      prompt: 'a cat',
      seed: 42,
      enhancedCompatibility: true,
      resources: [
        { id: 222, baseModel: 'SDXL 1.0', model: { type: 'TextualInversion' }, strength: 1 },
      ],
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'comfy',
      embeddings: ['urn:air:test:222'],
    });
  });

  // The surviving dispatcher suite covers the ControlNet case with enhancedCompatibility ON.
  // A controlnet has to force comfy with the flag OFF too, or it silently runs on a route
  // that cannot apply it.
  it('a controlnet forces the comfy engine even with enhancedCompatibility off', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'SD1',
      prompt: 'a cat',
      seed: 42,
      controlNets: [{ preprocessor: 'canny', image: { url: 'https://example.com/cn.png' } }],
    });
    const gen = (steps as Array<{ $type: string; input: unknown }>).filter(
      (step) => step.$type === 'imageGen'
    );
    expect(gen).toHaveLength(1);
    expect(gen[0]!.input).toMatchObject({ engine: 'comfy' });
    expect(gen[0]!.input).toHaveProperty('controlNets');
  });

  // The emitted model literal, not just the engine: a version-id-to-model mapping both
  // lanes got wrong would have passed the old differential.
  it.each([
    { versionId: openaiVersionIds['v2.5-flare'], model: 'gpt-image-2.5-flare' },
    { versionId: openaiVersionIds['v2.5-sunburst'], model: 'gpt-image-2.5-sunburst' },
  ])('openai $model resolves from its version id', async ({ versionId, model }) => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'OpenAI',
      prompt: 'a cat',
      seed: 42,
      model: versionId,
    });
    expect(steps).toHaveLength(1);
    expect(firstInput(steps)).toMatchObject({
      engine: 'openai',
      model,
      operation: 'createImage',
    });
  });

  // OpenAI retired gpt-image-1: a remix still carrying v1 must reach the wire as 1.5.
  it('a request carrying retired v1 is sent as gpt-image-1.5', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'OpenAI',
      prompt: 'a cat',
      seed: 42,
      model: openaiVersionIds.v1,
      transparent: true,
    });
    expect(firstInput(steps)).toMatchObject({
      engine: 'openai',
      model: 'gpt-image-1.5',
      background: 'transparent',
      operation: 'createImage',
    });
  });

  // The handler's own map, for a caller that skips the graph's remap.
  it.each([
    { label: 'v1', model: { id: openaiVersionIds.v1 } },
    { label: 'no model', model: undefined },
  ])('the handler never emits gpt-image-1 ($label)', async ({ model }) => {
    const steps = (await createOpenAIInput(
      { ecosystem: 'OpenAI', workflow: 'txt2img', prompt: 'a cat', quantity: 1, model } as never,
      ctx
    )) as Array<{ input: { model: string } }>;
    expect(steps[0]!.input.model).toBe('gpt-image-1.5');
  });
});

describe('qwen 2.1', () => {
  it('creates 2K images through comfy with release-specific LoRAs', async () => {
    const steps = await dispatch({
      workflow: 'txt2img',
      ecosystem: 'Qwen21',
      prompt: 'a teapot',
      seed: 42,
      resolution: '2K',
      aspectRatio: '16:9',
      cfgScale: 2.5,
      steps: 37,
      outputFormat: 'png',
      images: [IMAGE],
      resources: [{ id: 135, baseModel: 'Qwen 2.1', model: { type: 'LORA' }, strength: 0.6 }],
    });
    expect(steps).toHaveLength(1);
    expect(firstInput(steps)).toMatchObject({
      engine: 'comfy',
      ecosystem: 'qwen',
      model: '2.1',
      operation: 'createImage',
      width: 2048,
      height: 1152,
      cfgScale: 2.5,
      steps: 37,
      sampler: 'euler',
      scheduler: 'simple',
      outputFormat: 'png',
      loras: { 'urn:air:test:135': 0.6 },
    });
    expect(firstInput(steps)).not.toHaveProperty('images');
    expect(firstInput(steps)).not.toHaveProperty('resolution');
    // The hosted default is what `model: '2.1'` already means to the orchestrator.
    expect(firstInput(steps)).not.toHaveProperty('diffusionModel');
  });

  it('sends ten references and resolution without read-only edit dimensions', async () => {
    const images = Array.from({ length: 10 }, (_, i) => ({
      ...IMAGE,
      url: `https://example.com/${i}.png`,
    }));
    const steps = await dispatch({
      workflow: 'img2img:edit',
      ecosystem: 'Qwen21',
      prompt: 'a teapot',
      seed: 42,
      resolution: '2K',
      aspectRatio: '16:9',
      images,
    });
    expect(steps).toHaveLength(1);
    expect(firstInput(steps)).toMatchObject({
      engine: 'comfy',
      ecosystem: 'qwen',
      model: '2.1',
      operation: 'editImage',
      resolution: 2048,
      cfgScale: 1,
      steps: 25,
      images: images.map((image) => image.url),
    });
    expect(firstInput(steps)).not.toHaveProperty('width');
    expect(firstInput(steps)).not.toHaveProperty('height');
    expect(firstInput(steps)).not.toHaveProperty('diffusionModel');
  });

  // Fed straight to the dispatcher, bypassing `parse`: the picker is model-locked, so the
  // graph substitutes any other checkpoint back to the default and no parsed input can reach
  // this branch. Without it the suite cannot tell "omitted for the default" from "never sent".
  it('names a non-default checkpoint as diffusionModel', async () => {
    const data = {
      workflow: 'txt2img',
      ecosystem: 'Qwen21',
      prompt: 'a teapot',
      seed: 42,
      resolution: '1K',
      aspectRatio: { value: '1:1', width: 1024, height: 1024 },
      model: { id: 424242, baseModel: 'Qwen 2.1', model: { type: 'Checkpoint' } },
    } as unknown as GenerationData;

    const steps = await createFormGraphStepInput(data, ctx);
    expect(firstInput(steps)).toMatchObject({ diffusionModel: 'urn:air:test:424242' });
  });
});

describe('wan v2.2', () => {
  it('emits videoGen + interpolation on the multi-step path', async () => {
    wan22MultiStep = true;
    try {
      const steps = await dispatch({
        workflow: 'txt2vid',
        ecosystem: 'WanVideo-22-T2V-A14B',
        prompt: 'a cat',
        seed: 42,
        shift: 10,
      });
      expect((steps as Array<{ $type: string }>).map((step) => step.$type)).toEqual([
        'videoGen',
        'videoInterpolation',
      ]);
      // main's FAL migration pinned these alongside the step shape: the move was ONTO
      // comfy at a reduced frame rate, with interpolation making up the difference.
      expect(firstInput(steps)).toMatchObject({ provider: 'comfy', fps: 12 });
    } finally {
      wan22MultiStep = false;
    }
  });
});

// dbMock is imported for its module-level effect (the Prisma stub); reference it so the
// import survives organize-imports.
void dbMock;
