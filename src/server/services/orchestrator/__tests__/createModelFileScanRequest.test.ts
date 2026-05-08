import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockDbWrite,
  mockSubmitWorkflow,
  mockLogToAxiom,
  mockStringifyAIR,
  mockResolveDownloadUrl,
  mockIsProd,
} = vi.hoisted(() => ({
  mockDbWrite: {
    modelFile: { update: vi.fn() },
    modelFileHash: { upsert: vi.fn() },
  },
  mockSubmitWorkflow: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockStringifyAIR: vi.fn().mockReturnValue('urn:air:sd1:checkpoint:civitai:100@10'),
  // Pre-flight resolver. Default success so the existing happy-path tests
  // don't regress; failure-path tests reset to mockRejectedValue.
  mockResolveDownloadUrl: vi.fn().mockResolvedValue({ url: 'https://cdn.example/file' }),
  mockIsProd: { value: true },
}));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  // surface enums consumed at module-load time
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: {},
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

vi.mock('~/shared/utils/air', () => ({ stringifyAIR: mockStringifyAIR }));

vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: mockResolveDownloadUrl,
}));

// Use a getter so tests can flip isProd between cases.
vi.mock('~/env/other', () => ({
  get isProd() {
    return mockIsProd.value;
  },
}));

vi.mock('~/env/server', () => ({
  env: {
    ORCHESTRATOR_ACCESS_TOKEN: 'token',
    NEXTAUTH_URL: 'https://civitai.test',
    WEBHOOK_TOKEN: 'wh-token',
  },
}));

// orchestrator.service.ts pulls in cf-images-utils which validates
// NEXT_PUBLIC_* env vars at import-time. Stub it to keep tests hermetic.
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string) => url,
}));

import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';

const baseInput = {
  fileId: 1,
  modelVersionId: 10,
  modelId: 100,
  modelType: 'Checkpoint' as const,
  baseModel: 'SD 1.5',
  url: 's3://bucket/key.safetensors',
};

beforeEach(() => {
  mockDbWrite.modelFile.update.mockReset().mockResolvedValue({});
  mockDbWrite.modelFileHash.upsert.mockReset().mockResolvedValue({});
  mockSubmitWorkflow.mockReset();
  mockLogToAxiom.mockReset();
  mockStringifyAIR.mockClear();
  // Reset to success default — failure-path tests opt into mockRejectedValue
  mockResolveDownloadUrl.mockReset().mockResolvedValue({ url: 'https://cdn.example/file' });
  mockIsProd.value = true; // default: prod
  // Avoid burning the real 60s sleep inside the pre-flight retry path. Tests
  // that hit the not-found path can spy on this to assert the wait happened.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createModelFileScanRequest', () => {
  describe('dev fake-success skip path', () => {
    it('fakes success when !isProd AND no ORCHESTRATOR_ACCESS_TOKEN', async () => {
      mockIsProd.value = false;
      vi.resetModules();
      vi.doMock('~/env/server', () => ({
        env: {
          ORCHESTRATOR_ACCESS_TOKEN: undefined,
          NEXTAUTH_URL: 'https://civitai.test',
          WEBHOOK_TOKEN: 'wh-token',
        },
      }));
      const { createModelFileScanRequest: fn } = await import(
        '~/server/services/orchestrator/orchestrator.service'
      );

      await fn(baseInput);

      // Marks the file as fully scanned + creates a placeholder SHA256 hash
      expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          scanRequestedAt: expect.any(Date),
          scannedAt: expect.any(Date),
          virusScanResult: 'Success',
          pickleScanResult: 'Success',
        }),
      });
      expect(mockDbWrite.modelFileHash.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { fileId_type: { fileId: 1, type: 'SHA256' } },
        })
      );
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    });

    it('does NOT take the dev-skip path when isProd is true even without a token', async () => {
      mockIsProd.value = true;
      vi.resetModules();
      vi.doMock('~/env/server', () => ({
        env: {
          ORCHESTRATOR_ACCESS_TOKEN: undefined,
          NEXTAUTH_URL: 'https://civitai.test',
          WEBHOOK_TOKEN: 'wh-token',
        },
      }));
      const { createModelFileScanRequest: fn } = await import(
        '~/server/services/orchestrator/orchestrator.service'
      );
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await fn(baseInput);

      // Real submission attempted, NO placeholder hash created
      expect(mockSubmitWorkflow).toHaveBeenCalled();
      expect(mockDbWrite.modelFileHash.upsert).not.toHaveBeenCalled();
    });

    it('does NOT take the dev-skip path when token is present even in non-prod', async () => {
      mockIsProd.value = false;
      vi.resetModules();
      vi.doMock('~/env/server', () => ({
        env: {
          ORCHESTRATOR_ACCESS_TOKEN: 'present',
          NEXTAUTH_URL: 'https://civitai.test',
          WEBHOOK_TOKEN: 'wh-token',
        },
      }));
      const { createModelFileScanRequest: fn } = await import(
        '~/server/services/orchestrator/orchestrator.service'
      );
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await fn(baseInput);

      expect(mockSubmitWorkflow).toHaveBeenCalled();
      expect(mockDbWrite.modelFileHash.upsert).not.toHaveBeenCalled();
    });
  });

  describe('real submission path', () => {
    it('builds the workflow with all 4 scan steps using the same AIR string', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest(baseInput);

      expect(mockStringifyAIR).toHaveBeenCalledWith({
        baseModel: 'SD 1.5',
        type: 'Checkpoint',
        modelId: 100,
        id: 10,
        fileId: 1,
      });
      const submitCall = mockSubmitWorkflow.mock.calls[0][0];
      const stepTypes = submitCall.body.steps.map((s: { $type: string }) => s.$type);
      expect(stepTypes).toEqual([
        'modelClamScan',
        'modelPickleScan',
        'modelHash',
        'modelParseMetadata',
      ]);
      // All steps share the same AIR
      for (const step of submitCall.body.steps) {
        expect(step.input.model).toBe('urn:air:sd1:checkpoint:civitai:100@10');
      }
    });

    it('threads fileId + modelVersionId through workflow.metadata for callback resolution', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest(baseInput);

      const submitCall = mockSubmitWorkflow.mock.calls[0][0];
      expect(submitCall.body.metadata).toEqual({ fileId: 1, modelVersionId: 10 });
    });

    it('registers a callback to /api/webhooks/model-file-scan-result', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest(baseInput);

      const submitCall = mockSubmitWorkflow.mock.calls[0][0];
      expect(submitCall.body.callbacks[0].url).toContain(
        '/api/webhooks/model-file-scan-result'
      );
      expect(submitCall.body.callbacks[0].url).toContain('token=wh-token');
      expect(submitCall.body.callbacks[0].type).toEqual([
        'workflow:succeeded',
        'workflow:failed',
        'workflow:expired',
        'workflow:canceled',
      ]);
    });

    it('respects the priority parameter', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest({ ...baseInput, priority: 'low' });

      const submitCall = mockSubmitWorkflow.mock.calls[0][0];
      for (const step of submitCall.body.steps) {
        expect(step.priority).toBe('low');
      }
    });

    it('marks scanRequestedAt=now on successful submission to prevent double-submit', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest(baseInput);

      expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { scanRequestedAt: expect.any(Date) },
      });
    });

    it('returns the workflow data on success', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1', status: 'pending' },
        error: null,
        response: { status: 200 },
      });

      const result = await createModelFileScanRequest(baseInput);

      expect(result).toEqual({ id: 'wf-1', status: 'pending' });
    });
  });

  describe('submitWorkflow failure path (transient)', () => {
    it('throws ModelFileScanSubmissionError with code=transient and status when submitWorkflow returns no data', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: null,
        error: { message: 'bad request' },
        response: { status: 400 },
      });

      const err = await createModelFileScanRequest(baseInput).catch((e) => e);
      expect(err).toBeInstanceOf(ModelFileScanSubmissionError);
      expect(err.code).toBe('transient');
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/Failed to submit model file scan workflow for file 1.*status 400/);
    });

    it('logs to Axiom with file context + submissionErrorCode=transient before throwing', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: null,
        error: { message: 'bad' },
        response: { status: 500 },
      });

      await expect(createModelFileScanRequest(baseInput)).rejects.toThrow();

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          name: 'model-file-scan',
          fileId: 1,
          modelVersionId: 10,
          responseStatus: 500,
          submissionErrorCode: 'transient',
        })
      );
    });

    it('does NOT mark scanRequestedAt when submission fails (avoids freezing the file)', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: null,
        error: { message: 'bad' },
        response: { status: 400 },
      });

      await expect(createModelFileScanRequest(baseInput)).rejects.toThrow();

      // Only the post-success update would write scanRequestedAt; verify it didn't run.
      expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled();
    });
  });

  describe('pre-flight URL resolution (not-found path)', () => {
    it('proceeds to submitWorkflow when resolveDownloadUrl succeeds on first try', async () => {
      mockResolveDownloadUrl.mockResolvedValueOnce({ url: 'https://cdn/x' });
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest(baseInput);

      expect(mockResolveDownloadUrl).toHaveBeenCalledTimes(1);
      expect(mockResolveDownloadUrl).toHaveBeenCalledWith(1, 's3://bucket/key.safetensors');
      expect(mockSubmitWorkflow).toHaveBeenCalled();
    });

    it('retries pre-flight once after a 60s wait when the first attempt fails (sync-lag tolerance)', async () => {
      mockResolveDownloadUrl
        .mockRejectedValueOnce(new Error('not in resolver yet'))
        .mockResolvedValueOnce({ url: 'https://cdn/x' });
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      const promise = createModelFileScanRequest(baseInput);
      // Run microtasks for the first reject, then advance the 60s sleep.
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      expect(mockResolveDownloadUrl).toHaveBeenCalledTimes(2);
      expect(mockSubmitWorkflow).toHaveBeenCalled();
    });

    it('throws code=not-found when both pre-flight attempts fail', async () => {
      mockResolveDownloadUrl
        .mockRejectedValueOnce(new Error('first miss'))
        .mockRejectedValueOnce(new Error('still missing'));

      const promise = createModelFileScanRequest(baseInput).catch((e) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await promise;

      expect(err).toBeInstanceOf(ModelFileScanSubmissionError);
      expect(err.code).toBe('not-found');
      // submitWorkflow must NOT run when we can't even resolve the file URL.
      expect(mockSubmitWorkflow).not.toHaveBeenCalled();
      // scanRequestedAt write only happens on success; verify it didn't fire.
      expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled();
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'model-file-scan',
          submissionErrorCode: 'not-found',
          fileId: 1,
        })
      );
    });

    it('skips pre-flight entirely when preflight=false (inline upload path)', async () => {
      mockResolveDownloadUrl.mockRejectedValue(new Error('would fail if called'));
      mockSubmitWorkflow.mockResolvedValue({
        data: { id: 'wf-1' },
        error: null,
        response: { status: 200 },
      });

      await createModelFileScanRequest({ ...baseInput, preflight: false });

      expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
      expect(mockSubmitWorkflow).toHaveBeenCalled();
    });
  });
});
