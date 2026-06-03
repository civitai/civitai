import { describe, it, expect } from 'vitest';
import { getStepParams, getStepResources, WorkflowData, StepData } from '../index';
import type { WorkflowDataOptions } from '../index';
import type {
  NormalizedStep,
  NormalizedWorkflow,
  NormalizedWorkflowMetadata,
} from '../orchestration-new.service';

const defaultOptions: WorkflowDataOptions = {
  domain: { green: false, blue: false, red: false } as any,
  nsfwEnabled: false,
};

// =============================================================================
// Client helpers: getStepParams / getStepResources
// =============================================================================

function makeStep(metadata: Partial<NormalizedStep['metadata']>): NormalizedStep {
  return {
    $type: 'textToImage',
    name: '$0',
    output: [],
    metadata: { ...metadata },
  } as NormalizedStep;
}

function makeWorkflow(metadata?: NormalizedWorkflow['metadata']): NormalizedWorkflow {
  return {
    id: 'wf-1',
    status: 'succeeded',
    createdAt: new Date(),
    transactions: [],
    tags: [],
    steps: [],
    metadata,
  } as NormalizedWorkflow;
}

/** Build a bare WorkflowData for tests that only need metadata fallback behavior. */
function makeWorkflowData(metadata?: NormalizedWorkflowMetadata): WorkflowData {
  return new WorkflowData({ steps: [], metadata } as any, defaultOptions);
}

describe('getStepParams', () => {
  it('returns step params when present', () => {
    const step = makeStep({ params: { prompt: 'step prompt', steps: 30 } });
    const workflow = makeWorkflow({ params: { prompt: 'wf prompt' }, resources: [] });

    expect(getStepParams(step, workflow)).toEqual({ prompt: 'step prompt', steps: 30 });
  });

  it('falls back to workflow params when step has none', () => {
    const step = makeStep({});
    const workflow = makeWorkflow({ params: { prompt: 'wf prompt', steps: 20 }, resources: [] });

    expect(getStepParams(step, workflow)).toEqual({ prompt: 'wf prompt', steps: 20 });
  });

  it('returns empty object when neither has params', () => {
    const step = makeStep({});
    expect(getStepParams(step)).toEqual({});
  });

  it('returns empty object when workflow is undefined', () => {
    const step = makeStep({});
    expect(getStepParams(step, undefined)).toEqual({});
  });

  it('returns empty object when workflow metadata is undefined', () => {
    const step = makeStep({});
    const workflow = makeWorkflow(undefined);
    expect(getStepParams(step, workflow)).toEqual({});
  });
});

describe('getStepResources', () => {
  it('returns step resources when present', () => {
    const step = makeStep({
      resources: [{ id: 1, modelName: 'SD 1.5' }] as any,
    });
    const workflow = makeWorkflow({
      params: {},
      resources: [{ id: 2, modelName: 'SDXL' }] as any,
    });

    expect(getStepResources(step, workflow)).toEqual([{ id: 1, modelName: 'SD 1.5' }]);
  });

  it('falls back to workflow resources when step has none', () => {
    const step = makeStep({});
    const workflow = makeWorkflow({
      params: {},
      resources: [{ id: 2, modelName: 'SDXL' }] as any,
    });

    expect(getStepResources(step, workflow)).toEqual([{ id: 2, modelName: 'SDXL' }]);
  });

  it('returns empty array when neither has resources', () => {
    const step = makeStep({});
    expect(getStepResources(step)).toEqual([]);
  });

  it('returns empty array when workflow metadata is undefined', () => {
    const step = makeStep({});
    const workflow = makeWorkflow(undefined);
    expect(getStepResources(step, workflow)).toEqual([]);
  });
});

// =============================================================================
// Two-layer metadata model
// =============================================================================

describe('two-layer metadata model', () => {
  it('new standard gen: step has no params, workflow has them', () => {
    // New writes: step.metadata is empty (or has images feedback only)
    // workflow.metadata has the form input snapshot
    const step = makeStep({ images: { 'img-1': { feedback: 'liked' } } });
    const workflow = makeWorkflow({
      params: { prompt: 'a cat', steps: 30, workflow: 'image:create' },
      resources: [{ id: 123, modelName: 'SD 1.5' }] as any,
      remixOfId: 42,
    });

    // Client resolves via helpers
    expect(getStepParams(step, workflow)).toEqual({
      prompt: 'a cat',
      steps: 30,
      workflow: 'image:create',
    });
    expect(getStepResources(step, workflow)).toEqual([{ id: 123, modelName: 'SD 1.5' }]);
  });

  it('legacy standard gen: step has params, no workflow metadata', () => {
    // Old data: everything on step.metadata, workflow.metadata is empty
    const step = makeStep({
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }] as any,
    });
    const workflow = makeWorkflow(undefined);

    expect(getStepParams(step, workflow)).toEqual({ prompt: 'a cat', steps: 30 });
    expect(getStepResources(step, workflow)).toEqual([{ id: 123 }]);
  });

  it('enhancement step: complete step params are used verbatim, no workflow leak', () => {
    // Enhancement steps (upscale, remove-bg) store the SOURCE generation's complete params on
    // the step; workflow.metadata holds the enhancement form input. Either/or returns the step
    // params verbatim, so the upscale form's images/upscaler/workflow key never leak into a
    // remix of the original. Mirrors the real EXIF-sourced case where the source params carry
    // no `workflow` key, so a merge would have leaked `img2img:upscale`.
    const step = makeStep({
      params: { prompt: 'a cat', seed: 123, baseModel: 'SDXL' },
    });
    const wf = makeWorkflowData({
      params: {
        workflow: 'img2img:upscale',
        images: [{ url: 'https://example/source.png', width: 512, height: 512 }],
        upscaler: 'air:upscaler',
        upscaleWidth: 1024,
        upscaleHeight: 1024,
        outputFormat: 'png',
      } as any,
      resources: [],
    });
    const sd = new StepData(step, wf);

    expect(sd.params).toEqual({ prompt: 'a cat', seed: 123, baseModel: 'SDXL' });
  });

  it('partialParams (wildcard/snippet variant): spreads the params delta over workflow params', () => {
    // Snippet variants store a small DELTA in `params` and set `partialParams: true`. The client
    // spreads that delta over the workflow form snapshot (the server sends only the delta).
    const step = makeStep({
      partialParams: true,
      params: { prompt: 'a substituted cat', negativePrompt: 'blurry' },
    });
    const wf = makeWorkflowData({
      params: {
        workflow: 'txt2img',
        prompt: 'a #animal', // template prompt — overridden by the substituted delta prompt
        negativePrompt: 'lowres', // overridden too
        steps: 30,
        cfgScale: 7,
        sampler: 'Euler a',
        seed: 999,
      } as any,
      resources: [],
    });
    const sd = new StepData(step, wf);

    expect(sd.params).toEqual({
      workflow: 'txt2img',
      prompt: 'a substituted cat',
      negativePrompt: 'blurry',
      steps: 30,
      cfgScale: 7,
      sampler: 'Euler a',
      seed: 999,
    });
  });

  it('without partialParams, a step with params is used verbatim (no spread)', () => {
    // Same shapes as above but no flag — the step params are treated as a complete snapshot and
    // returned verbatim; the workflow settings are NOT merged in.
    const step = makeStep({ params: { prompt: 'a substituted cat', negativePrompt: 'blurry' } });
    const wf = makeWorkflowData({
      params: { workflow: 'txt2img', steps: 30, cfgScale: 7 } as any,
      resources: [],
    });
    const sd = new StepData(step, wf);

    expect(sd.params).toEqual({ prompt: 'a substituted cat', negativePrompt: 'blurry' });
  });

  it('returns step resources when present', () => {
    const step = makeStep({ resources: [{ id: 1 }] as any });
    const wf = makeWorkflowData({ params: {}, resources: [{ id: 2 }] as any });
    const sd = new StepData(step, wf);

    expect(sd.resources).toEqual([{ id: 1 }]);
  });

  it('falls back to workflow resources when step has none', () => {
    const step = makeStep({});
    const wf = makeWorkflowData({ params: {}, resources: [{ id: 2 }] as any });
    const sd = new StepData(step, wf);

    expect(sd.resources).toEqual([{ id: 2 }]);
  });

  it('resolves remixOfId with fallback', () => {
    const step = makeStep({});
    const wf = makeWorkflowData({ params: {}, resources: [], remixOfId: 42 });
    const sd = new StepData(step, wf);

    expect(sd.remixOfId).toBe(42);
  });

  it('step remixOfId takes precedence over workflow', () => {
    const step = makeStep({ remixOfId: 10 });
    const wf = makeWorkflowData({ params: {}, resources: [], remixOfId: 42 });
    const sd = new StepData(step, wf);

    expect(sd.remixOfId).toBe(10);
  });

  it('prompt convenience accessor returns prompt from params', () => {
    const step = makeStep({ params: { prompt: 'hello world' } });
    const sd = new StepData(step, makeWorkflowData());

    expect(sd.prompt).toBe('hello world');
  });

  it('prompt returns undefined when no params', () => {
    const step = makeStep({});
    const sd = new StepData(step, makeWorkflowData());

    expect(sd.prompt).toBeUndefined();
  });

  it('returns defaults when workflow has no metadata', () => {
    const step = makeStep({});
    const sd = new StepData(step, makeWorkflowData());

    expect(sd.params).toEqual({});
    expect(sd.resources).toEqual([]);
    expect(sd.remixOfId).toBeUndefined();
  });

  it('works with Omit<NormalizedStep, "output"> (no generic needed)', () => {
    const step: Omit<NormalizedStep, 'output'> = {
      $type: 'textToImage',
      name: '$0',
      metadata: { params: { prompt: 'test' } },
    } as any;
    const sd = new StepData(step, makeWorkflowData());

    expect(sd.params).toEqual({ prompt: 'test' });
  });
});
