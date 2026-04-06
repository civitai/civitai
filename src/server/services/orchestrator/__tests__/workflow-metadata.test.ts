import { describe, it, expect } from 'vitest';
import { buildStepSource, resolveStepSource } from '../workflow-metadata';
import { getStepParams, getStepResources, WorkflowData, StepData } from '../index';
import type { WorkflowDataOptions } from '../index';
import type { NormalizedStep, NormalizedWorkflow } from '../orchestration-new.service';

const defaultOptions: WorkflowDataOptions = {
  domain: { green: false, blue: false, red: false } as any,
  nsfwEnabled: false,
};

// =============================================================================
// Write Path
// =============================================================================

describe('buildStepSource', () => {
  it('wraps source metadata in a source field', () => {
    const result = buildStepSource({
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123, model: 'sd15' }],
    });

    expect(result).toEqual({
      source: {
        params: { prompt: 'a cat', steps: 30 },
        resources: [{ id: 123, model: 'sd15' }],
      },
    });
  });

  it('returns undefined when no source metadata', () => {
    expect(buildStepSource(undefined)).toBeUndefined();
  });

  it('defaults missing params and resources to empty', () => {
    const result = buildStepSource({});

    expect(result).toEqual({
      source: {
        params: {},
        resources: [],
      },
    });
  });

  it('passes flags through to source alongside params/resources', () => {
    const result = buildStepSource({
      params: { prompt: 'a cat' },
      resources: [{ id: 1 }],
      remixOfId: 42,
    });

    expect(result).toEqual({
      source: {
        params: { prompt: 'a cat' },
        resources: [{ id: 1 }],
        remixOfId: 42,
      },
    });
  });

  it('produces different source metadata per step (multi-step batch upscale)', () => {
    const source1 = buildStepSource({
      params: { prompt: 'a cat' },
      resources: [{ id: 1 }],
    });

    const source2 = buildStepSource({
      params: { prompt: 'a dog' },
      resources: [{ id: 2 }],
    });

    expect(source1!.source.params).toEqual({ prompt: 'a cat' });
    expect(source2!.source.params).toEqual({ prompt: 'a dog' });
  });
});

// =============================================================================
// Read Path
// =============================================================================

describe('resolveStepSource', () => {
  it('returns source from new format (step.metadata.source)', () => {
    const stepMeta = {
      params: { upscaler: '4x-ultrasharp' },
      resources: [],
      source: {
        params: { prompt: 'a cat', steps: 30 },
        resources: [{ id: 123 }],
      },
    };

    const result = resolveStepSource(stepMeta);

    expect(result).toEqual({
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }],
    });
  });

  it('returns step root params/resources for legacy with transformations', () => {
    const stepMeta = {
      params: { prompt: 'original generation' },
      resources: [{ id: 1 }],
      transformations: [
        {
          workflow: 'img2img:upscale',
          params: { upscaler: '4x-ultrasharp' },
          resources: [{ id: 10 }],
        },
      ],
    };

    const result = resolveStepSource(stepMeta);

    // In legacy format, step.metadata root IS the original generation
    expect(result).toEqual({
      params: { prompt: 'original generation' },
      resources: [{ id: 1 }],
    });
  });

  it('returns undefined for legacy without transformations (not an enhancement)', () => {
    const stepMeta = {
      params: { prompt: 'a cat' },
      resources: [{ id: 1 }],
    };

    expect(resolveStepSource(stepMeta)).toBeUndefined();
  });

  it('returns undefined for empty step metadata', () => {
    expect(resolveStepSource({})).toBeUndefined();
  });

  it('returns flags from new format source', () => {
    const stepMeta = {
      params: { upscaler: '4x-ultrasharp' },
      resources: [],
      source: {
        params: { prompt: 'a cat' },
        resources: [{ id: 1 }],
        remixOfId: 42,
      },
    };

    const result = resolveStepSource(stepMeta);
    expect(result).toEqual({
      params: { prompt: 'a cat' },
      resources: [{ id: 1 }],
      remixOfId: 42,
    });
  });

  it('returns flags from legacy with transformations', () => {
    const stepMeta = {
      params: { prompt: 'a cat' },
      resources: [{ id: 1 }],
      remixOfId: 42,
      isPrivateGeneration: true,
      transformations: [
        { workflow: 'img2img:upscale', params: { upscaler: '4x-ultrasharp' }, resources: [] },
      ],
    };

    const result = resolveStepSource(stepMeta);
    expect(result).toEqual({
      params: { prompt: 'a cat' },
      resources: [{ id: 1 }],
      remixOfId: 42,
      isPrivateGeneration: true,
    });
  });

  it('prefers new format source over legacy transformations', () => {
    const stepMeta = {
      source: { params: { prompt: 'new source' }, resources: [] },
      params: { prompt: 'legacy root' },
      resources: [{ id: 1 }],
      transformations: [{ workflow: 'upscale', params: {}, resources: [] }],
    };

    const result = resolveStepSource(stepMeta);

    expect(result).toEqual({
      params: { prompt: 'new source' },
      resources: [],
    });
  });
});

// =============================================================================
// Round-trip: Write → Read
// =============================================================================

describe('round-trip: write then read', () => {
  it('standard generation — no source', () => {
    const stepMeta = {
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }],
      remixOfId: 42,
    };

    const source = resolveStepSource(stepMeta);
    expect(source).toBeUndefined();
  });

  it('enhancement step — source round-trips', () => {
    const originalGeneration = {
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }],
    };

    // Write: build source for enhancement step
    const sourceField = buildStepSource(originalGeneration);
    const stepMeta = {
      params: { upscaler: '4x-ultrasharp', creativity: 0.5 },
      resources: [],
      ...sourceField,
    };

    // Read: resolve source
    const resolved = resolveStepSource(stepMeta);

    expect(resolved).toEqual({
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }],
    });
  });

  it('enhancement step — flags round-trip through source', () => {
    const originalGeneration = {
      params: { prompt: 'a cat', steps: 30 },
      resources: [{ id: 123 }],
      remixOfId: 42,
    };

    const sourceField = buildStepSource(originalGeneration);
    const stepMeta = {
      params: { upscaler: '4x-ultrasharp' },
      resources: [],
      ...sourceField,
    };

    const resolved = resolveStepSource(stepMeta);
    expect(resolved!.remixOfId).toBe(42);
    expect(resolved!.params).toEqual({ prompt: 'a cat', steps: 30 });
  });

  it('batch upscale — per-step source round-trips', () => {
    const upscaleParams = { upscaler: '4x-ultrasharp' };

    const step0Meta = {
      params: upscaleParams,
      resources: [],
      ...buildStepSource({ params: { prompt: 'a cat' }, resources: [{ id: 1 }] }),
    };
    const step1Meta = {
      params: upscaleParams,
      resources: [],
      ...buildStepSource({ params: { prompt: 'a dog' }, resources: [{ id: 2 }] }),
    };

    expect(resolveStepSource(step0Meta)!.params).toEqual({ prompt: 'a cat' });
    expect(resolveStepSource(step1Meta)!.params).toEqual({ prompt: 'a dog' });
  });
});

// =============================================================================
// Client helpers: getStepParams / getStepResources
// =============================================================================

function makeStep(metadata: Partial<NormalizedStep['metadata']>): NormalizedStep {
  return {
    $type: 'textToImage',
    name: '$0',
    images: [],
    metadata: { ...metadata },
  } as NormalizedStep;
}

function makeWorkflow(
  metadata?: NormalizedWorkflow['metadata']
): NormalizedWorkflow {
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

  it('enhancement step: step has own params, workflow has form input', () => {
    // Enhancement steps always have their own params (the enhancement action)
    const step = makeStep({
      params: { upscaler: '4x-ultrasharp', creativity: 0.5 },
      resources: [],
    });
    const workflow = makeWorkflow({
      params: { upscaler: '4x-ultrasharp', creativity: 0.5, workflow: 'img2img:upscale' },
      resources: [],
    });

    // getStepParams returns step's own params (not falling through)
    expect(getStepParams(step, workflow)).toEqual({
      upscaler: '4x-ultrasharp',
      creativity: 0.5,
    });
  });

  it('isPrivateGeneration lives on workflow metadata', () => {
    const workflow = makeWorkflow({
      params: { prompt: 'a cat' },
      resources: [],
      isPrivateGeneration: true,
    });

    expect(workflow.metadata?.isPrivateGeneration).toBe(true);
  });
});

// =============================================================================
// WorkflowData class
// =============================================================================

describe('WorkflowData', () => {
  it('resolves params from workflow metadata', () => {
    const workflow = makeWorkflow({
      params: { prompt: 'a cat', steps: 30 },
      resources: [],
    });
    const wf = new WorkflowData(workflow, defaultOptions);

    expect(wf.params).toEqual({ prompt: 'a cat', steps: 30 });
  });

  it('resolves resources from workflow metadata', () => {
    const workflow = makeWorkflow({
      params: {},
      resources: [{ id: 1, modelName: 'SD 1.5' }] as any,
    });
    const wf = new WorkflowData(workflow, defaultOptions);

    expect(wf.resources).toEqual([{ id: 1, modelName: 'SD 1.5' }]);
  });

  it('resolves remixOfId from workflow metadata', () => {
    const workflow = makeWorkflow({
      params: {},
      resources: [],
      remixOfId: 42,
    });
    const wf = new WorkflowData(workflow, defaultOptions);

    expect(wf.remixOfId).toBe(42);
  });

  it('returns defaults when workflow metadata is undefined', () => {
    const workflow = makeWorkflow(undefined);
    const wf = new WorkflowData(workflow, defaultOptions);

    expect(wf.params).toEqual({});
    expect(wf.resources).toEqual([]);
    expect(wf.remixOfId).toBeUndefined();
  });

  it('step() creates StepData bound to workflow metadata', () => {
    const workflow = makeWorkflow({
      params: { prompt: 'wf prompt' },
      resources: [{ id: 1 }] as any,
      remixOfId: 42,
    });
    const step = makeStep({});
    const wf = new WorkflowData(workflow, defaultOptions);
    const sd = wf.step(step);

    expect(sd.params).toEqual({ prompt: 'wf prompt' });
    expect(sd.resources).toEqual([{ id: 1 }]);
    expect(sd.remixOfId).toBe(42);
  });

  it('exposes underlying NormalizedWorkflow properties directly', () => {
    const workflow = makeWorkflow({
      params: { prompt: 'a cat' },
      resources: [],
    });
    const wf = new WorkflowData(workflow, defaultOptions);

    expect(wf.id).toBe('wf-1');
    expect(wf.status).toBe('succeeded');
    expect(wf.tags).toEqual([]);
  });
});

// =============================================================================
// StepData class
// =============================================================================

describe('StepData', () => {
  it('returns step params when present', () => {
    const step = makeStep({ params: { prompt: 'step prompt' } });
    const wfMeta = { params: { prompt: 'wf prompt' }, resources: [] };
    const sd = new StepData(step, wfMeta);

    expect(sd.params).toEqual({ prompt: 'step prompt' });
  });

  it('falls back to workflow metadata when step has no params', () => {
    const step = makeStep({});
    const wfMeta = { params: { prompt: 'wf prompt', steps: 20 }, resources: [] };
    const sd = new StepData(step, wfMeta);

    expect(sd.params).toEqual({ prompt: 'wf prompt', steps: 20 });
  });

  it('returns step resources when present', () => {
    const step = makeStep({ resources: [{ id: 1 }] as any });
    const wfMeta = { params: {}, resources: [{ id: 2 }] as any };
    const sd = new StepData(step, wfMeta);

    expect(sd.resources).toEqual([{ id: 1 }]);
  });

  it('falls back to workflow resources when step has none', () => {
    const step = makeStep({});
    const wfMeta = { params: {}, resources: [{ id: 2 }] as any };
    const sd = new StepData(step, wfMeta);

    expect(sd.resources).toEqual([{ id: 2 }]);
  });

  it('resolves remixOfId with fallback', () => {
    const step = makeStep({});
    const wfMeta = { params: {}, resources: [], remixOfId: 42 };
    const sd = new StepData(step, wfMeta);

    expect(sd.remixOfId).toBe(42);
  });

  it('step remixOfId takes precedence over workflow', () => {
    const step = makeStep({ remixOfId: 10 });
    const wfMeta = { params: {}, resources: [], remixOfId: 42 };
    const sd = new StepData(step, wfMeta);

    expect(sd.remixOfId).toBe(10);
  });

  it('prompt convenience accessor returns prompt from params', () => {
    const step = makeStep({ params: { prompt: 'hello world' } });
    const sd = new StepData(step);

    expect(sd.prompt).toBe('hello world');
  });

  it('prompt returns undefined when no params', () => {
    const step = makeStep({});
    const sd = new StepData(step);

    expect(sd.prompt).toBeUndefined();
  });

  it('returns defaults when constructed with undefined wfMetadata', () => {
    const step = makeStep({});
    const sd = new StepData(step, undefined);

    expect(sd.params).toEqual({});
    expect(sd.resources).toEqual([]);
    expect(sd.remixOfId).toBeUndefined();
  });

  it('works with Omit<NormalizedStep, "images"> (no generic needed)', () => {
    const step: Omit<NormalizedStep, 'images'> = {
      $type: 'textToImage',
      name: '$0',
      metadata: { params: { prompt: 'test' } },
    } as any;
    const sd = new StepData(step);

    expect(sd.params).toEqual({ prompt: 'test' });
  });
});
