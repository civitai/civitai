import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as WorkflowSteps from '~/server/services/orchestrator/workflowSteps';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

const h = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  patchWorkflowSteps: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: h.getWorkflow,
  queryWorkflows: h.queryWorkflows,
}));
vi.mock('~/server/services/orchestrator/workflowSteps', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowSteps>()),
  patchWorkflowSteps: h.patchWorkflowSteps,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));

import { OnboardingSteps } from '~/server/common/enums';
import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = (isModerator = false) =>
  orchestratorRouter.createCaller({
    user: {
      id: 7,
      isModerator,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const WEIGHTS = 'https://orchestration.civitai.com/v2/consumer/blobs/EPOCH1.safetensors?sig=x';
const LEGACY_WEIGHTS = 'https://orchestration.civitai.com/v2/consumer/blobs/EPOCH1-legacy?sig=y';
const SAMPLE = 'https://orchestration.civitai.com/v2/consumer/blobs/SAMPLE1.jpg';
// A continued run starts from its source run's epoch, named by that epoch's blob.
const SOURCE_EPOCH = 'urn:air:flux1:lora:blob:SOURCE-EPOCH5';

const trainingStep = {
  $type: 'training',
  name: 'train',
  metadata: { modelFileId: 11, x: WEIGHTS },
  preparation: [{ resource: SOURCE_EPOCH, status: 'downloaded' }],
  input: { engine: 'ai-toolkit', epochs: 10, continueFrom: SOURCE_EPOCH },
  output: {
    moderationStatus: 'approved',
    epochs: [
      {
        epochNumber: 1,
        model: {
          type: 'model',
          id: 'EPOCH1',
          jobId: 'JOB-EPOCH1',
          available: true,
          url: WEIGHTS,
          publicUrl: 'https://blobs.example.invalid/EPOCH1.safetensors',
          urlExpiresAt: '2099-01-01T00:00:00Z',
        },
        samples: [
          { type: 'image', id: 'SAMPLE1', jobId: 'JOB-EPOCH1', available: true, url: SAMPLE },
        ],
        traceUrl: 'https://orchestration.civitai.com/v2/consumer/jobs/JOB-EPOCH1/trace',
      },
    ],
  },
};
const legacyStep = {
  $type: 'imageResourceTraining',
  name: 'train-legacy',
  metadata: { modelFileId: 12 },
  input: { model: 'urn:air:sdxl:checkpoint:civitai:1@2', continueFrom: SOURCE_EPOCH },
  output: {
    moderationStatus: 'approved',
    epochs: [
      {
        epochNumber: 1,
        blobName: 'EPOCH1-legacy',
        blobUrl: LEGACY_WEIGHTS,
        sampleImages: [SAMPLE],
      },
    ],
    sampleImagesPrompts: [],
  },
};
const generationStep = {
  $type: 'textToImage',
  name: 'gen',
  metadata: { params: { prompt: 'a cat' } },
  preparation: [{ resource: 'urn:air:sdxl:checkpoint:civitai:1@2', status: 'downloaded' }],
  input: { prompt: 'a cat' },
  output: { images: [{ id: 'IMG1', url: 'https://example.invalid/IMG1.jpg', available: true }] },
};
const workflow = (steps: unknown[] = [trainingStep, legacyStep]) => ({
  id: 'wf-1',
  status: 'succeeded',
  steps,
});

describe('orchestrator.getWorkflow — a training run’s weights', () => {
  beforeEach(() => {
    h.getWorkflow.mockReset().mockImplementation(async () => workflow());
  });

  it('names no epoch weights to a non-moderator, keeping the rest of each epoch', async () => {
    const result = (await caller().getWorkflow({ workflowId: 'wf-1' })) as ReturnType<
      typeof workflow
    > & { steps: [typeof trainingStep, typeof legacyStep] };

    expect(result.steps[0].output.epochs[0]).toEqual({
      epochNumber: 1,
      model: { type: 'model', available: true },
      samples: [{ type: 'image', id: 'SAMPLE1', available: true, url: SAMPLE }],
    });
    expect(result.steps[1].output.epochs[0]).toEqual({ epochNumber: 1, sampleImages: [SAMPLE] });
    expect(JSON.stringify(result)).not.toMatch(/EPOCH1/);
  });

  it("leaves out a continued run's source epoch, keeping the rest of its input", async () => {
    const result = (await caller().getWorkflow({ workflowId: 'wf-1' })) as {
      steps: [typeof trainingStep, typeof legacyStep];
    };

    expect(result.steps[0].input).toEqual({ engine: 'ai-toolkit', epochs: 10 });
    expect(result.steps[1].input).toEqual({ model: 'urn:air:sdxl:checkpoint:civitai:1@2' });
    expect(JSON.stringify(result)).not.toContain('SOURCE-EPOCH5');
  });

  it('names them to a moderator', async () => {
    await expect(caller(true).getWorkflow({ workflowId: 'wf-1' })).resolves.toEqual(workflow());
  });

  it("returns a generation workflow's outputs unchanged", async () => {
    h.getWorkflow.mockResolvedValue(workflow([generationStep]));
    await expect(caller().getWorkflow({ workflowId: 'wf-1' })).resolves.toEqual(
      workflow([generationStep])
    );
  });

  it('leaves a non-training step untouched beside a training step', async () => {
    h.getWorkflow.mockResolvedValue(workflow([trainingStep, generationStep]));
    const result = (await caller().getWorkflow({ workflowId: 'wf-1' })) as { steps: unknown[] };
    expect(result.steps[1]).toEqual(generationStep);
  });

  it.each(['Training', 'IMAGERESOURCETRAINING'])(
    'withholds a training step whose type comes back as %s',
    async ($type) => {
      h.getWorkflow.mockResolvedValue(workflow([{ ...trainingStep, $type }]));
      const result = await caller().getWorkflow({ workflowId: 'wf-1' });
      expect(JSON.stringify(result)).not.toMatch(/EPOCH1|SOURCE-EPOCH5/);
    }
  );

  it("keeps only a training step's model file from its metadata", async () => {
    const result = (await caller().getWorkflow({ workflowId: 'wf-1' })) as {
      steps: { metadata: unknown }[];
    };
    expect(result.steps.map((step) => step.metadata)).toEqual([
      { modelFileId: 11 },
      { modelFileId: 12 },
    ]);
  });

  it("drops a training step's preparing resources", async () => {
    const result = (await caller().getWorkflow({ workflowId: 'wf-1' })) as {
      steps: Record<string, unknown>[];
    };
    expect(result.steps[0]).not.toHaveProperty('preparation');
  });
});

describe('orchestrator.getWorkflow — steps that read a training run', () => {
  const reader = (name: string, $type: string, from: string) => ({
    $type,
    name,
    metadata: { copied: WEIGHTS },
    input: { fields: { e: { $ref: from, path: 'output.epochs[*].model' } } },
    output: { fields: { e: [{ url: WEIGHTS, id: 'EPOCH1' }] } },
  });
  const read = async (steps: unknown[], isModerator = false) => {
    h.getWorkflow.mockReset().mockResolvedValue(workflow(steps));
    return (await caller(isModerator).getWorkflow({ workflowId: 'wf-1' })) as {
      steps: Record<string, unknown>[];
    };
  };

  it.each(['merge', 'blobArchive'])(
    'drops the output of a %s step reading a training step',
    async ($type) => {
      const result = await read([trainingStep, reader('m', $type, 'train')]);
      expect(result.steps[1]).not.toHaveProperty('output');
      expect(JSON.stringify(result)).not.toMatch(/EPOCH1/);
    }
  );

  it('drops the output of every step in a chain from a training step', async () => {
    const result = await read([
      trainingStep,
      reader('m', 'merge', 'train'),
      reader('x', 'echo', 'm'),
      reader('y', 'chatCompletion', 'x'),
    ]);
    expect(result.steps.slice(1).map((step) => 'output' in step)).toEqual([false, false, false]);
    expect(JSON.stringify(result)).not.toMatch(/EPOCH1/);
  });

  it('drops the output of a chain listed before the step it reads', async () => {
    const result = await read([
      reader('y', 'echo', 'x'),
      reader('x', 'echo', 'm'),
      reader('m', 'merge', 'train'),
      trainingStep,
    ]);
    expect(result.steps.slice(0, 3).map((step) => 'output' in step)).toEqual([false, false, false]);
  });

  it("drops a reading step's metadata too", async () => {
    const result = await read([trainingStep, reader('m', 'merge', 'train')]);
    expect(result.steps[1]).not.toHaveProperty('metadata');
  });

  it('drops the output of a repeat that runs a training step, and of its readers', async () => {
    const repeat = {
      $type: 'repeat',
      name: 'r',
      input: {
        for: { $ref: 'list', path: 'output', as: 'i' },
        template: { $type: 'training', input: {} },
      },
      output: { items: [{ epochs: [{ model: { url: WEIGHTS, id: 'EPOCH1' } }] }] },
    };
    const result = await read([repeat, reader('m', 'merge', 'r')]);
    expect(result.steps.map((step) => 'output' in step)).toEqual([false, false]);
    expect(JSON.stringify(result)).not.toMatch(/EPOCH1/);
  });

  it('drops the output of a step reading a step the workflow does not name', async () => {
    const result = await read([trainingStep, reader('m', 'merge', 'elsewhere')]);
    expect(result.steps[1]).not.toHaveProperty('output');
  });

  // The shapes the orchestrator and the App Blocks graph use (workflow-graph.ts): `$ref` is a step
  // name, the workflow's arguments, or a repeat's loop variable, with the path beside it.
  it('keeps steps that read the workflow arguments or a loop variable', async () => {
    const fromArguments = {
      $type: 'textToImage',
      name: 'a',
      input: { prompt: { $ref: '$arguments', path: 'prompt' } },
      output: { images: [{ id: 'IMG2', url: 'https://example.invalid/IMG2.jpg' }] },
    };
    const repeat = {
      $type: 'repeat',
      name: 'r',
      input: {
        for: { $ref: '$arguments', path: 'prompts', as: 'item' },
        template: { $type: 'textToImage', input: { prompt: { $ref: 'item', path: 'text' } } },
      },
      output: { items: [{ images: [{ id: 'IMG3' }] }] },
    };
    const merge = {
      $type: 'merge',
      name: 'm',
      input: { fields: { images: { $ref: 'a', path: 'output.images[*].id', reduce: 'concat' } } },
      output: { fields: { images: ['IMG2'] } },
    };
    const result = await read([trainingStep, fromArguments, repeat, merge]);
    expect(result.steps.slice(1)).toEqual([fromArguments, repeat, merge]);
  });

  it('drops the output of a repeat iterating a training step, whatever its template reads', async () => {
    const repeat = {
      $type: 'repeat',
      name: 'r',
      input: {
        for: { $ref: 'train', path: 'output.epochs', as: 'item' },
        template: {
          $type: 'merge',
          input: { fields: { id: { $ref: 'item', path: 'model.id', reduce: 'concat' } } },
        },
      },
      output: { items: [{ fields: { id: ['EPOCH1'] } }] },
    };
    const steps = [trainingStep, repeat];
    const result = await read(steps);
    expect(result.steps[1]).not.toHaveProperty('output');
    expect(JSON.stringify(result)).not.toMatch(/EPOCH1/);
    expect(await read(steps, true)).toEqual(workflow(steps));
  });

  it('keeps a step that reads no training step', async () => {
    const result = await read([trainingStep, generationStep, reader('m', 'merge', 'gen')]);
    expect(result.steps[2]).toEqual(reader('m', 'merge', 'gen'));
  });

  it('shows a moderator every step as it is', async () => {
    const steps = [trainingStep, reader('m', 'merge', 'train'), reader('x', 'echo', 'm')];
    expect(await read(steps, true)).toEqual(workflow(steps));
  });
});

describe('orchestrator.queryWorkflowsByTags — a training run’s weights', () => {
  beforeEach(() => {
    h.queryWorkflows.mockReset().mockImplementation(async () => ({
      nextCursor: undefined,
      items: [workflow(), workflow([generationStep])],
    }));
  });

  it('names no epoch weights to a non-moderator', async () => {
    const { items } = await caller().queryWorkflowsByTags({ tags: ['training'] });
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toMatch(/EPOCH1|SOURCE-EPOCH5/);
    expect(items[1]).toEqual(workflow([generationStep]));
  });

  it('names them to a moderator', async () => {
    const { items } = await caller(true).queryWorkflowsByTags({ tags: ['training'] });
    expect(items).toEqual([workflow(), workflow([generationStep])]);
  });
});

describe('orchestrator.patch — a step patch stays in the step’s metadata', () => {
  beforeEach(() => h.patchWorkflowSteps.mockReset().mockResolvedValue(undefined));

  it('roots `from` under /metadata as it does `path`', async () => {
    await caller().patch({
      steps: [
        {
          workflowId: 'wf-1',
          stepName: 'train',
          patches: [
            { op: 'copy', from: '/output/epochs/0/model/url', path: '/x' },
            { op: 'add', path: '/y', value: 1 },
          ],
        },
      ],
    });

    expect(h.patchWorkflowSteps.mock.calls[0][0].input[0].patches).toEqual([
      { op: 'copy', from: '/metadata/output/epochs/0/model/url', path: '/metadata/x' },
      { op: 'add', path: '/metadata/y', value: 1 },
    ]);
  });
});
