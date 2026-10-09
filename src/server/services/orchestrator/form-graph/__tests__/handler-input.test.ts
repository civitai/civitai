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
import { createFormGraphStepInput } from '../index';

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
      enablePromptExpansion: false,
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
    expect(firstInput(expanded)).toMatchObject({ enablePromptExpansion: true });
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
      enablePromptExpansion: false,
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
    expect(firstInput(steps)).toMatchObject({ engine: 'hunyuan', model: 'urn:air:test:1313562' });
  });

  it('a saved fp8 selection still submits the default', async () => {
    const steps = await dispatch({
      workflow: 'txt2vid',
      ecosystem: 'HyV1',
      prompt: 'a cat',
      model: 1314512,
    });
    expect(firstInput(steps)).toMatchObject({ model: 'urn:air:test:1313562' });
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
      expect(firstInput(steps)).toMatchObject({ provider: 'comfy', frameRate: 12 });
    } finally {
      wan22MultiStep = false;
    }
  });
});

// dbMock is imported for its module-level effect (the Prisma stub); reference it so the
// import survives organize-imports.
void dbMock;
