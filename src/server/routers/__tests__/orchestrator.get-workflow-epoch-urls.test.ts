import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Workflows from '~/server/services/orchestrator/workflows';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

/** `orchestrator.getWorkflow` names a training run's weights to moderators only. */

const h = vi.hoisted(() => ({ getWorkflow: vi.fn() }));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: h.getWorkflow,
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
  metadata: { modelFileId: 11 },
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
        samples: [{ type: 'image', id: 'SAMPLE1', available: true, url: SAMPLE }],
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
});
