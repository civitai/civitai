import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbWrite,
  mockSubmitWorkflow,
  mockLogToAxiom,
  mockStringifyAIR,
  mockIsProd,
} = vi.hoisted(() => ({
  mockDbWrite: {
    modelFile: { update: vi.fn() },
    modelFileHash: { upsert: vi.fn() },
  },
  mockSubmitWorkflow: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockStringifyAIR: vi.fn().mockReturnValue('urn:air:sd1:checkpoint:civitai:100@10'),
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

import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';

const baseInput = {
  fileId: 1,
  modelVersionId: 10,
  modelId: 100,
  modelType: 'Checkpoint' as const,
  baseModel: 'SD 1.5',
};

beforeEach(() => {
  mockDbWrite.modelFile.update.mockReset().mockResolvedValue({});
  mockDbWrite.modelFileHash.upsert.mockReset().mockResolvedValue({});
  mockSubmitWorkflow.mockReset();
  mockLogToAxiom.mockReset();
  mockStringifyAIR.mockClear();
  mockIsProd.value = true; // default: prod
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

  describe('failure path', () => {
    it('throws when submitWorkflow returns no data, with the response status in the message', async () => {
      mockSubmitWorkflow.mockResolvedValue({
        data: null,
        error: { message: 'bad request' },
        response: { status: 400 },
      });

      await expect(createModelFileScanRequest(baseInput)).rejects.toThrow(
        /Failed to submit model file scan workflow for file 1.*status 400/
      );
    });

    it('logs to Axiom with file context before throwing', async () => {
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
});
