import { describe, it, expect } from 'vitest';
import { buildStepSource, resolveStepSource } from '../workflow-metadata';
import { isStepRef, buildStepOutputRef, assignStepNames } from '../step-ref';

// =============================================================================
// Multi-graph → multi-step conversion
// =============================================================================

/**
 * Simulates what the service layer would do when processing multiple graph inputs
 * into a single workflow submission. Each graph input becomes a step with its own
 * params/resources in step.metadata. Enhancement steps additionally get `source`.
 */
function processMultiGraphInputs(
  inputs: Array<{
    workflow: string;
    params: Record<string, unknown>;
    resources: Array<Record<string, unknown>>;
    /** Present when this step references an earlier step's output */
    imageRef?: { stepIndex: number; outputPath: string };
    /** Source metadata for enhancement steps (original generation's params/resources) */
    sourceMetadata?: { params: Record<string, unknown>; resources: Array<Record<string, unknown>> };
    /** Flags like remixOfId, isPrivateGeneration */
    flags?: { remixOfId?: number; isPrivateGeneration?: boolean };
  }>
) {
  const steps = inputs.map((input, i) => {
    // Build step input — if imageRef exists, use $ref instead of an actual URL
    const stepInput: Record<string, unknown> = { ...input.params };
    if (input.imageRef) {
      stepInput.image = buildStepOutputRef(
        input.imageRef.stepIndex,
        'image' // derived from preceding step's output type in real code
      );
    }

    // Step metadata: always has params/resources, optionally has source and flags
    const metadata: Record<string, unknown> = {
      params: input.params,
      resources: input.resources,
      ...input.flags,
      ...buildStepSource(input.sourceMetadata),
    };

    return {
      $type: input.workflow,
      input: stepInput,
      metadata,
    };
  });

  return { steps: assignStepNames(steps) };
}

// =============================================================================
// Tests
// =============================================================================

describe('processMultiGraphInputs', () => {
  it('single graph input produces one step with params on step.metadata', () => {
    const { steps } = processMultiGraphInputs([
      {
        workflow: 'textToImage',
        params: { prompt: 'a cat', steps: 30, cfgScale: 7 },
        resources: [{ id: 123, model: 'sd15' }],
      },
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('$0');
    expect(steps[0].metadata.params).toEqual({ prompt: 'a cat', steps: 30, cfgScale: 7 });
    expect(steps[0].metadata.resources).toEqual([{ id: 123, model: 'sd15' }]);
  });

  it('single step with flags stores them on step.metadata', () => {
    const { steps } = processMultiGraphInputs([
      {
        workflow: 'textToImage',
        params: { prompt: 'a cat' },
        resources: [],
        flags: { remixOfId: 42, isPrivateGeneration: true },
      },
    ]);

    expect(steps[0].metadata.remixOfId).toBe(42);
    expect(steps[0].metadata.isPrivateGeneration).toBe(true);
  });

  it('heterogeneous multi-step: imageGen + aceStepAudio with $ref', () => {
    const { steps } = processMultiGraphInputs([
      {
        workflow: 'imageGen',
        params: { engine: 'flux2', model: 'klein', steps: 8, prompt: 'album cover' },
        resources: [],
      },
      {
        workflow: 'aceStepAudio',
        params: { musicDescription: 'Rock track', lyrics: '...', duration: 60, bpm: 140 },
        resources: [],
        imageRef: { stepIndex: 0, outputPath: 'output.images[0].url' },
      },
    ]);

    // Step 0: imageGen with its own params
    expect(steps[0].name).toBe('$0');
    expect(steps[0].metadata.params).toEqual({
      engine: 'flux2',
      model: 'klein',
      steps: 8,
      prompt: 'album cover',
    });

    // Step 1: aceStepAudio with its own params + $ref to step 0
    expect(steps[1].name).toBe('$1');
    expect(steps[1].metadata.params).toEqual({
      musicDescription: 'Rock track',
      lyrics: '...',
      duration: 60,
      bpm: 140,
    });
    const imageInput = (steps[1].input as any).image;
    expect(isStepRef(imageInput)).toBe(true);
    expect(imageInput).toEqual({ $ref: '$0', path: 'output.images[0].url' });

    // Neither step has source — not an enhancement
    expect(steps[0].metadata.source).toBeUndefined();
    expect(steps[1].metadata.source).toBeUndefined();
  });

  it('enhancement chain: txt2img → face-fix with source on step 1', () => {
    const { steps } = processMultiGraphInputs([
      {
        workflow: 'textToImage',
        params: { prompt: 'a portrait', steps: 30 },
        resources: [{ id: 1, model: 'sd15' }],
      },
      {
        workflow: 'comfy',
        params: { faceFixStrength: 0.7 },
        resources: [],
        imageRef: { stepIndex: 0, outputPath: 'output.images[0].url' },
        sourceMetadata: {
          params: { prompt: 'a portrait', steps: 30 },
          resources: [{ id: 1, model: 'sd15' }],
        },
      },
    ]);

    // Step 0: no source
    expect(steps[0].metadata.source).toBeUndefined();

    // Step 1: has source pointing to original generation
    expect(steps[1].metadata.source).toEqual({
      params: { prompt: 'a portrait', steps: 30 },
      resources: [{ id: 1, model: 'sd15' }],
    });

    // Step 1 also has its own params
    expect(steps[1].metadata.params).toEqual({ faceFixStrength: 0.7 });
  });

  it('batch upscale: same params per step, different source per step', () => {
    const upscaleParams = { upscaler: '4x-ultrasharp', creativity: 0.5 };

    const { steps } = processMultiGraphInputs([
      {
        workflow: 'imageUpscaler',
        params: upscaleParams,
        resources: [],
        sourceMetadata: { params: { prompt: 'a cat' }, resources: [{ id: 1 }] },
      },
      {
        workflow: 'imageUpscaler',
        params: upscaleParams,
        resources: [],
        sourceMetadata: { params: { prompt: 'a dog' }, resources: [{ id: 2 }] },
      },
    ]);

    // Both steps have the same upscale params
    expect(steps[0].metadata.params).toEqual(upscaleParams);
    expect(steps[1].metadata.params).toEqual(upscaleParams);

    // Each step has its own source
    expect(resolveStepSource(steps[0].metadata)!.params).toEqual({ prompt: 'a cat' });
    expect(resolveStepSource(steps[1].metadata)!.params).toEqual({ prompt: 'a dog' });
  });
});

describe('multi-graph read path', () => {
  it('reads per-step params and source from new format', () => {
    const step0Meta = {
      params: { prompt: 'a portrait', steps: 30 },
      resources: [{ id: 1 }],
    };
    const step1Meta = {
      params: { faceFixStrength: 0.7 },
      resources: [],
      source: {
        params: { prompt: 'a portrait', steps: 30 },
        resources: [{ id: 1 }],
      },
    };

    // Each step has its own params
    expect(step0Meta.params.prompt).toBe('a portrait');
    expect(step1Meta.params).toEqual({ faceFixStrength: 0.7 });

    // Only step 1 has source
    expect(resolveStepSource(step0Meta)).toBeUndefined();
    expect(resolveStepSource(step1Meta)!.params).toEqual({ prompt: 'a portrait', steps: 30 });
  });

  it('handles legacy single-step generation (backward compat)', () => {
    const stepMeta = {
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }],
      remixOfId: 42,
    };

    // Params/resources/flags are on step.metadata — same as always
    expect(stepMeta.params.prompt).toBe('a cat');
    expect(stepMeta.remixOfId).toBe(42);

    // No source — not an enhancement
    expect(resolveStepSource(stepMeta)).toBeUndefined();
  });

  it('handles legacy enhancement with transformations (backward compat)', () => {
    const stepMeta = {
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 1 }],
      transformations: [
        {
          workflow: 'img2img:upscale',
          params: { upscaler: '4x-ultrasharp', upscaleWidth: 2048 },
          resources: [{ id: 10 }],
        },
      ],
    };

    // Source = step root (the original generation)
    const source = resolveStepSource(stepMeta);
    expect(source!.params).toEqual({ prompt: 'a cat', steps: 30 });
  });
});
