import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { loggingMock } from '~/__tests__/mocks';
import { wasServerFaultLogged } from '~/server/logging/client';

const submitWorkflow = vi.fn();
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  getGetUrl: vi.fn(),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(),
}));
vi.mock('~/server/services/training.service', () => ({ getTrainingServiceStatus: vi.fn() }));

import { createTrainingWhatIfWorkflow } from '~/server/services/orchestrator/training/training.orch';

const logToAxiom = loggingMock.logToAxiom;

const whatIf = () =>
  createTrainingWhatIfWorkflow({
    token: 't',
    currencies: [],
    userId: 55,
    model: 'civitai:1@2',
    priority: 'normal',
    engine: 'kohya',
    trainingDataImagesCount: 10,
    samplePrompts: [],
    params: {},
  } as never);

const lastPayload = () => logToAxiom.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('createTrainingWhatIfWorkflow logging', () => {
  beforeEach(() => {
    submitWorkflow.mockReset();
    logToAxiom.mockClear();
  });

  describe('when the submit fails', () => {
    // A fresh error each time: markServerFaultLogged keys on object identity.
    const masked = () =>
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'We are having trouble reaching the generation service.',
        cause: new Error('upstream 502 pricing mage-flow'),
      });

    it('logs the orchestrator cause, not the message the user sees', async () => {
      const error = masked();
      submitWorkflow.mockRejectedValue(error);

      await expect(whatIf()).rejects.toBe(error);

      const payload = lastPayload();
      expect(JSON.stringify(payload)).toContain('upstream 502 pricing mage-flow');
      expect(payload.type).toBe('error');
      expect((payload.data as { userId: number }).userId).toBe(55);
    });

    it('marks the fault so the central chokepoint does not log it a second time', async () => {
      const error = masked();
      submitWorkflow.mockRejectedValue(error);

      await expect(whatIf()).rejects.toBe(error);

      expect(wasServerFaultLogged(error)).toBe(true);
    });

    it('keeps a rejected settings combination at info, and does not mark it', async () => {
      const error = new TRPCError({ code: 'BAD_REQUEST', message: 'resolution too high' });
      submitWorkflow.mockRejectedValue(error);

      await expect(whatIf()).rejects.toBe(error);

      expect(lastPayload().type).toBe('info');
      expect(wasServerFaultLogged(error)).toBe(false);
    });
  });

  describe('when the submit succeeds', () => {
    const priced = (total: number | null) =>
      submitWorkflow.mockResolvedValue({ cost: { total, fees: {} }, steps: [{}] });

    it('reports a missing or negative price', async () => {
      priced(null);
      await whatIf();
      expect(lastPayload().message).toBe('Orchestrator returned an unusable cost');

      logToAxiom.mockClear();
      priced(-1);
      await whatIf();
      expect(lastPayload().message).toBe('Orchestrator returned an unusable cost');
    });

    it('treats a zero price as spendable', async () => {
      priced(0);

      const result = await whatIf();

      expect(result.cost).toBe(0);
      expect(logToAxiom).not.toHaveBeenCalled();
    });
  });
});
