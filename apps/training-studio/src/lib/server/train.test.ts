import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardByType } from '$lib/data/trainingModels';
import type { TrainingRunInput } from '$lib/train-core';

// The server half must read the live training status on every submit, or a blocked model trains.
const status = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  read: null as null | (() => Promise<string | null>),
}));
const submitWorkflow = vi.hoisted(() => vi.fn());
const getWorkflow = vi.hoisted(() => vi.fn());
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('./axiom', () => ({ logToAxiom: vi.fn(), safeError: (e: unknown) => e }));
vi.mock('./orchestrator', () => ({ orchestratorClient: () => ({}) }));
vi.mock('./signals', () => ({ workflowSignalCallbacks: () => [] }));
vi.mock('./text-check', () => ({ requestTextCheck: () => async () => undefined }));
vi.mock('./redis', () => ({
  getSysRedis: () => ({
    hGet: () => (status.read ? status.read() : Promise.resolve(JSON.stringify(status.value))),
  }),
}));
vi.mock('@civitai/orchestration-client', () => ({
  Air: { isAir: () => false },
  submitWorkflow,
  getWorkflow,
  getResource: vi.fn(),
  headBlob: vi.fn(),
  updateWorkflow: vi.fn(),
}));

const { submitTrainingBatch, continueTraining } = await import('./train');

const krea2 = cardByType('krea2')!.versions[0]!;
const run: TrainingRunInput = {
  ecosystem: krea2.ecosystem,
  steps: 2000,
  epochs: 10,
  unetLr: 1e-4,
  textEncoderLr: 0,
  networkDim: 32,
  networkAlpha: 32,
  resolution: 1024,
  batchSize: 1,
  lrScheduler: 'constant',
  optimizer: 'AdamW8Bit',
  trigger: 'ohwx',
  items: [{ air: 'blob-1', caption: 'ohwx' }],
  prompts: ['ohwx'],
  meta: { name: 'test' },
};

describe('server submit reads the training status', () => {
  beforeEach(() => {
    status.read = null;
    submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf' } });
  });

  it('refuses a run on a blocked model', async () => {
    status.value = { available: true, blockedModels: [krea2.key] };
    await expect(submitTrainingBatch('tok', [run], 1, null)).rejects.toThrow(
      /Krea 2 is temporarily unavailable/
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses keep-training a blocked model', async () => {
    status.value = { available: true, blockedModels: [krea2.key] };
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            $type: 'training',
            input: { engine: 'ai-toolkit', ecosystem: krea2.ecosystem, epochs: 10, steps: 2000 },
            output: { epochs: [{ epochNumber: 10, model: { id: 'b', available: true } }] },
          },
        ],
      },
    });
    await expect(
      continueTraining('tok', 1, { workflowId: 'wf', fromEpoch: 10, addEpochs: 1 }, null)
    ).rejects.toThrow(/Krea 2 is temporarily unavailable/);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses while training is switched off', async () => {
    status.value = { available: false, message: 'Paused for maintenance.' };
    await expect(submitTrainingBatch('tok', [run], 1, null)).rejects.toThrow(
      'Paused for maintenance.'
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  // A failed or slow read serves the last status read in this process (see service-status.test.ts
  // for the never-read case, which refuses).
  it('honours the last status read when the status read fails or times out', async () => {
    status.value = { available: true, blockedModels: [] };
    await submitTrainingBatch('tok', [run], 1, null);
    status.read = () => Promise.reject(new Error('redis down'));
    await expect(submitTrainingBatch('tok', [run], 1, null)).resolves.toEqual({
      workflowIds: ['wf'],
    });

    status.read = null;
    status.value = { available: false, message: 'Paused for maintenance.' };
    await expect(submitTrainingBatch('tok', [run], 1, null)).rejects.toThrow('Paused');
    submitWorkflow.mockClear();
    vi.useFakeTimers();
    try {
      status.read = () => new Promise(() => {});
      const pending = submitTrainingBatch('tok', [run], 1, null).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toMatchObject({ message: 'Paused for maintenance.' });
      expect(submitWorkflow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('submits when nothing is blocked', async () => {
    status.value = { available: true, blockedModels: [] };
    await expect(submitTrainingBatch('tok', [run], 1, null)).resolves.toEqual({
      workflowIds: ['wf'],
    });
  });
});
