import { beforeEach, describe, expect, it, vi } from 'vitest';

// The cores are covered in train-core.test.ts; here they only hand back the check the element gave
// them, so the element's own reading of the host hook is what is under test.
const core = vi.hoisted(() => ({
  submitTrainingBatch: vi.fn(),
  continueTraining: vi.fn(),
}));
vi.mock('$lib/train-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/train-core')>()),
  submitTrainingBatch: core.submitTrainingBatch,
  continueTraining: core.continueTraining,
}));
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: () => ({ interceptors: { response: { use: () => undefined } } }),
}));

import { elementBackend, type StudioElementHost } from './backend';
import { TrainingTextRefusedError, type TrainingTextCheck } from '$lib/training-text';

function host(checkTrainingText?: StudioElementHost['checkTrainingText']): StudioElementHost {
  return {
    getOrchestratorToken: async () => 'token',
    checkTrainingText,
    config: { orchestratorEndpoint: 'https://orchestrator.example' },
    hrefFor: () => '/',
    navigate: async () => undefined,
  };
}

/** The check each core was handed, as the element built it. */
const checkGiven = (fn: typeof core.submitTrainingBatch): TrainingTextCheck =>
  fn.mock.calls[0][2].checkText;

describe('elementBackend trigger word check', () => {
  beforeEach(() => {
    core.submitTrainingBatch.mockReset().mockResolvedValue({ workflowIds: [] });
    core.continueTraining.mockReset().mockResolvedValue('wf');
  });

  it.each([
    [
      'submitTraining',
      (b: ReturnType<typeof elementBackend>) => b.submitTraining([]),
      core.submitTrainingBatch,
    ],
    [
      'continueRun',
      (b: ReturnType<typeof elementBackend>) => b.continueRun('wf', 1, 1, []),
      core.continueTraining,
    ],
  ] as const)(
    '%s hands the core a check that refuses what the host refuses',
    async (_l, run, fn) => {
      const hostCheck = vi.fn(async () => ({ ok: false as const, error: 'blocked: x' }));
      await run(elementBackend(host(hostCheck)));
      const check = checkGiven(fn);
      await expect(check({ triggerWord: 'bad' })).rejects.toThrow(
        new TrainingTextRefusedError('blocked: x')
      );
      expect(hostCheck).toHaveBeenCalledWith({ triggerWord: 'bad' });
    }
  );

  it('passes what the host passes', async () => {
    await elementBackend(host(async () => ({ ok: true }))).submitTraining([]);
    await expect(
      checkGiven(core.submitTrainingBatch)({ triggerWord: 'ok' })
    ).resolves.toBeUndefined();
  });

  it('refuses every run when the host page offers no check', async () => {
    await elementBackend(host(undefined)).submitTraining([]);
    await expect(checkGiven(core.submitTrainingBatch)({ triggerWord: 'ok' })).rejects.toThrow();
  });

  it('lets a check that could not run fail rather than pass', async () => {
    const failure = new Error('check failed');
    await elementBackend(host(async () => Promise.reject(failure))).submitTraining([]);
    await expect(checkGiven(core.submitTrainingBatch)({ triggerWord: 'ok' })).rejects.toBe(failure);
  });
});
