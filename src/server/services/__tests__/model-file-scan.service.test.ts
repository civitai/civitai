import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbWrite,
  mockGetWorkflow,
  mockLogToAxiom,
  mockDeleteFilesForModelVersionCache,
  mockCreateNotification,
  mockModelsSearchIndexQueueUpdate,
  mockDataForModelsCacheRefresh,
  mockIsFlipt,
  mockRequestScannerTasks,
  mockCreateModelFileScanRequest,
  mockLimitConcurrency,
  mockUnpublishModelById,
} = vi.hoisted(() => {
  const mockModelFile = {
    findUnique: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  };

  const mockModelFileHash = {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  };

  const mockModelVersion = {
    findUnique: vi.fn(),
  };

  return {
    mockDbWrite: {
      modelFile: mockModelFile,
      modelFileHash: mockModelFileHash,
      modelVersion: mockModelVersion,
      $transaction: vi.fn(),
    },
    mockGetWorkflow: vi.fn(),
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
    mockDeleteFilesForModelVersionCache: vi.fn().mockResolvedValue(undefined),
    mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    mockModelsSearchIndexQueueUpdate: vi.fn().mockResolvedValue(undefined),
    mockDataForModelsCacheRefresh: vi.fn().mockResolvedValue(undefined),
    mockIsFlipt: vi.fn(),
    mockRequestScannerTasks: vi.fn(),
    mockCreateModelFileScanRequest: vi.fn(),
    // sequential runner so per-file effects assert deterministically
    mockLimitConcurrency: vi.fn(async (tasks: Array<() => Promise<unknown>>) => {
      for (const t of tasks) await t();
    }),
    mockUnpublishModelById: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('~/server/db/client', () => ({
  dbWrite: mockDbWrite,
  dbRead: mockDbWrite,
}));

vi.mock('@civitai/client', () => ({
  getWorkflow: mockGetWorkflow,
  submitWorkflow: vi.fn(),
  createCivitaiClient: vi.fn(),
  WorkflowStatus: { Pending: 'Pending', Running: 'Running', Completed: 'Completed' },
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: {},
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
}));

vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: mockDataForModelsCacheRefresh },
}));

vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: mockModelsSearchIndexQueueUpdate },
}));

vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: mockDeleteFilesForModelVersionCache,
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: { MODEL_FILE_SCAN_ORCHESTRATOR: 'model-file-scan-orchestrator' },
}));

// scan-files transitively imports delivery-worker which validates S3 env vars
// at module-load. Stub the legacy adapter directly to keep the test hermetic.
vi.mock('~/server/jobs/scan-files', () => ({
  requestScannerTasks: mockRequestScannerTasks,
  ScannerTasks: ['Import', 'Hash', 'Scan', 'Convert', 'ParseMetadata'],
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: mockCreateModelFileScanRequest,
}));

vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: mockLimitConcurrency,
}));

// model.service.ts has a heavy import surface (clickhouse, redis, search-index,
// etc) but we only need its `unpublishModelById` for unpublishBlockedModel.
// Stub the whole module to avoid loading its dep tree.
vi.mock('~/server/services/model.service', () => ({
  unpublishModelById: mockUnpublishModelById,
}));

import {
  applyScanOutcome,
  examinePickleImports,
  processModelFileScanResult,
  rescanModel,
  unpublishBlockedModel,
} from '~/server/services/model-file-scan.service';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';

describe('model-file-scan.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // examinePickleImports — pure function, payload normalization
  // ==========================================================================
  describe('examinePickleImports', () => {
    it('returns no danger and null message when exitCode is null (scan did not run)', () => {
      const result = examinePickleImports({ exitCode: null });
      expect(result).toEqual({ pickleScanMessage: null, hasDanger: false });
    });

    it('returns no danger and null message when exitCode is undefined', () => {
      const result = examinePickleImports({});
      expect(result).toEqual({ pickleScanMessage: null, hasDanger: false });
    });

    it('returns no danger and null message when exitCode is -1 (scan skipped)', () => {
      const result = examinePickleImports({ exitCode: -1 });
      expect(result).toEqual({ pickleScanMessage: null, hasDanger: false });
    });

    it('returns "No Pickle imports" when exitCode is 0 and no imports present', () => {
      const result = examinePickleImports({
        exitCode: 0,
        dangerousImports: [],
        globalImports: [],
      });
      expect(result).toEqual({ pickleScanMessage: 'No Pickle imports', hasDanger: false });
    });

    it('handles null dangerousImports and globalImports as empty', () => {
      const result = examinePickleImports({
        exitCode: 0,
        dangerousImports: null,
        globalImports: null,
      });
      expect(result).toEqual({ pickleScanMessage: 'No Pickle imports', hasDanger: false });
    });

    it('reports no danger for safe global imports only', () => {
      const result = examinePickleImports({
        exitCode: 0,
        dangerousImports: [],
        globalImports: ['torch,nn'],
      });
      expect(result.hasDanger).toBe(false);
      expect(result.pickleScanMessage).toContain('Detected Pickle imports (1)');
      expect(result.pickleScanMessage).not.toContain('Dangerous import detected');
      expect(result.pickleScanMessage).toContain('torch.nn');
    });

    it('reports danger when dangerousImports are present', () => {
      const result = examinePickleImports({
        exitCode: 1,
        dangerousImports: ['os,system'],
        globalImports: [],
      });
      expect(result.hasDanger).toBe(true);
      expect(result.pickleScanMessage).toContain('Dangerous import detected');
      expect(result.pickleScanMessage).toContain('*os.system*');
    });

    it('promotes pytorch_lightning ModelCheckpoint global to dangerous', () => {
      const result = examinePickleImports({
        exitCode: 0,
        dangerousImports: [],
        globalImports: ['pytorch_lightning.callbacks.model_checkpoint,ModelCheckpoint'],
      });
      expect(result.hasDanger).toBe(true);
      expect(result.pickleScanMessage).toContain('Dangerous import detected');
      expect(result.pickleScanMessage).toContain(
        '*pytorch_lightning.callbacks.model_checkpoint.ModelCheckpoint*'
      );
    });

    it('does not mutate caller arrays when promoting special imports', () => {
      const dangerousImports: string[] = [];
      const globalImports = ['pytorch_lightning.callbacks.model_checkpoint,ModelCheckpoint'];

      examinePickleImports({ exitCode: 0, dangerousImports, globalImports });

      expect(dangerousImports).toEqual([]);
      expect(globalImports).toEqual([
        'pytorch_lightning.callbacks.model_checkpoint,ModelCheckpoint',
      ]);
    });

    it('decodes URL-encoded import names', () => {
      const result = examinePickleImports({
        exitCode: 0,
        dangerousImports: ['os%2Csystem'],
        globalImports: [],
      });
      expect(result.pickleScanMessage).toContain('*os.system*');
    });

    it('counts both dangerous and global imports in the header', () => {
      const result = examinePickleImports({
        exitCode: 0,
        dangerousImports: ['os,system'],
        globalImports: ['torch,nn', 'numpy,array'],
      });
      expect(result.pickleScanMessage).toContain('Detected Pickle imports (3)');
    });
  });

  // ==========================================================================
  // applyScanOutcome — DB writes are the contract; cover every branch.
  // ==========================================================================
  describe('applyScanOutcome', () => {
    const baseFile = {
      id: 1,
      modelVersionId: 100,
      modelVersion: { modelId: 200 },
    };

    function setupFileFound(file: typeof baseFile | null = baseFile) {
      mockDbWrite.modelFile.findUnique.mockResolvedValue(file);
      mockDbWrite.modelFile.update.mockResolvedValue({});
      mockDbWrite.$transaction.mockResolvedValue([]);
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);
    }

    it('logs a warning and returns without writes when the file is not found', async () => {
      setupFileFound(null);

      await applyScanOutcome({ fileId: 999 });

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          name: 'apply-scan-outcome',
          fileId: 999,
        }),
        'webhooks'
      );
      expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled();
      expect(mockDeleteFilesForModelVersionCache).not.toHaveBeenCalled();
    });

    it('on failed=true, bumps scanRequestedAt and skips all other writes', async () => {
      setupFileFound();

      await applyScanOutcome({ fileId: 1, failed: true });

      expect(mockDbWrite.modelFile.update).toHaveBeenCalledTimes(1);
      expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { scanRequestedAt: expect.any(Date) },
      });
      expect(mockDeleteFilesForModelVersionCache).not.toHaveBeenCalled();
      expect(mockModelsSearchIndexQueueUpdate).not.toHaveBeenCalled();
      expect(mockDataForModelsCacheRefresh).not.toHaveBeenCalled();
    });

    it('advances scannedAt only when a scan actually ran (virusScan present)', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.scannedAt).toBeInstanceOf(Date);
      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Success);
      expect(updateCall.data.virusScanMessage).toBeNull();
    });

    it('does NOT advance scannedAt for hash-only or metadata-only updates', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        hashes: { [ModelHashType.SHA256]: 'abc' },
        headerData: { foo: 'bar' },
      });

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.scannedAt).toBeUndefined();
      expect(updateCall.data.headerData).toEqual({ foo: 'bar' });
    });

    it('writes pickleScan result and message when present', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        pickleScan: { result: ScanResultCode.Danger, message: 'bad imports' },
      });

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Danger);
      expect(updateCall.data.pickleScanMessage).toBe('bad imports');
      expect(updateCall.data.scannedAt).toBeInstanceOf(Date);
    });

    it('persists rawScanResult when supplied', async () => {
      setupFileFound();
      const envelope = { source: 'orchestrator', workflowId: 'wf-1' };

      await applyScanOutcome({ fileId: 1, rawScanResult: envelope });

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.rawScanResult).toEqual(envelope);
    });

    it('upserts hashes via deleteMany + createMany inside a transaction', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        hashes: {
          [ModelHashType.SHA256]: 'sha-1',
          [ModelHashType.AutoV2]: 'auto-1',
        },
      });

      expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
      expect(mockDbWrite.modelFileHash.deleteMany).toHaveBeenCalledWith({
        where: { fileId: 1 },
      });
      expect(mockDbWrite.modelFileHash.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          { fileId: 1, type: ModelHashType.SHA256, hash: 'sha-1' },
          { fileId: 1, type: ModelHashType.AutoV2, hash: 'auto-1' },
        ]),
      });
    });

    it('skips the hash transaction when all hash values are empty/falsy', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        hashes: { [ModelHashType.SHA256]: '' as unknown as string },
      });

      expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
      expect(mockDbWrite.modelFileHash.createMany).not.toHaveBeenCalled();
    });

    it('fires hash-fix notification when AutoV2 changes from a previous value', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue(baseFile);
      mockDbWrite.modelFile.update.mockResolvedValue({});
      mockDbWrite.$transaction.mockResolvedValue([]);
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([
        { type: ModelHashType.AutoV2, hash: 'old-auto-v2' },
      ]);
      mockDbWrite.modelVersion.findUnique.mockResolvedValue({
        id: 100,
        name: 'v1',
        model: { id: 200, name: 'My Model', userId: 42 },
      });

      await applyScanOutcome({
        fileId: 1,
        hashes: { [ModelHashType.AutoV2]: 'new-auto-v2' },
      });

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'model-hash-fix',
          userId: 42,
          key: 'model-hash-fix:200:1',
          details: expect.objectContaining({
            modelId: 200,
            versionId: 100,
            modelName: 'My Model',
            versionName: 'v1',
          }),
        })
      );
    });

    it('does NOT fire hash-fix notification when there is no pre-existing AutoV2', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue(baseFile);
      mockDbWrite.modelFile.update.mockResolvedValue({});
      mockDbWrite.$transaction.mockResolvedValue([]);
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);

      await applyScanOutcome({
        fileId: 1,
        hashes: { [ModelHashType.AutoV2]: 'new-auto-v2' },
      });

      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('does NOT fire hash-fix notification when AutoV2 is unchanged', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue(baseFile);
      mockDbWrite.modelFile.update.mockResolvedValue({});
      mockDbWrite.$transaction.mockResolvedValue([]);
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([
        { type: ModelHashType.AutoV2, hash: 'same-auto-v2' },
      ]);

      await applyScanOutcome({
        fileId: 1,
        hashes: { [ModelHashType.AutoV2]: 'same-auto-v2' },
      });

      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('queues a search index update and refreshes the model cache when modelId is known', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockDeleteFilesForModelVersionCache).toHaveBeenCalledWith(100);
      expect(mockModelsSearchIndexQueueUpdate).toHaveBeenCalledWith([
        { id: 200, action: expect.any(String) },
      ]);
      expect(mockDataForModelsCacheRefresh).toHaveBeenCalledWith(200);
    });

    it('skips search index + cache refresh when the modelVersion has no modelId', async () => {
      setupFileFound({ id: 1, modelVersionId: 100, modelVersion: null } as any);

      await applyScanOutcome({
        fileId: 1,
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockDeleteFilesForModelVersionCache).toHaveBeenCalledWith(100);
      expect(mockModelsSearchIndexQueueUpdate).not.toHaveBeenCalled();
      expect(mockDataForModelsCacheRefresh).not.toHaveBeenCalled();
    });

    it('prefers outcome.modelVersionId over the file lookup for cache invalidation', async () => {
      setupFileFound();

      await applyScanOutcome({
        fileId: 1,
        modelVersionId: 555,
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockDeleteFilesForModelVersionCache).toHaveBeenCalledWith(555);
    });
  });

  // ==========================================================================
  // processModelFileScanResult — orchestrator adapter normalization
  // ==========================================================================
  describe('processModelFileScanResult', () => {
    function makeReq(body: unknown) {
      return { body } as unknown as Parameters<typeof processModelFileScanResult>[0];
    }

    beforeEach(() => {
      // Default: file exists so applyScanOutcome can complete without warnings
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 1,
        modelVersionId: 100,
        modelVersion: { modelId: 200 },
      });
      mockDbWrite.modelFile.update.mockResolvedValue({});
      mockDbWrite.$transaction.mockResolvedValue([]);
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);
    });

    it('throws when the orchestrator returns no workflow data', async () => {
      mockGetWorkflow.mockResolvedValue({ data: null });

      await expect(
        processModelFileScanResult(
          makeReq({ workflowId: 'wf-missing', type: 'workflow', status: 'succeeded' })
        )
      ).rejects.toThrow('could not find workflow: wf-missing');
    });

    it('throws when workflow metadata.fileId is missing', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: { metadata: {}, steps: [] },
      });

      await expect(
        processModelFileScanResult(
          makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
        )
      ).rejects.toThrow('missing workflow metadata.fileId - wf-1');
    });

    it('on non-succeeded status, calls applyScanOutcome with failed=true and logs a warning', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1, modelVersionId: 100 },
          steps: [],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'failed' })
      );

      // failed=true path: only the scanRequestedAt bump
      expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { scanRequestedAt: expect.any(Date) },
      });
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          name: 'model-file-scan-result',
          status: 'failed',
        }),
        'webhooks'
      );
    });

    it('maps clamScan exitCode 0 to virusScan.Success with null message', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [{ $type: 'modelClamScan', output: { exitCode: 0, output: 'irrelevant' } }],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Success);
      expect(updateCall.data.virusScanMessage).toBeNull();
    });

    it('maps clamScan exitCode 1 to virusScan.Danger and preserves output message', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [{ $type: 'modelClamScan', output: { exitCode: 1, output: 'EICAR detected' } }],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Danger);
      expect(updateCall.data.virusScanMessage).toBe('EICAR detected');
    });

    it('maps unknown clamScan exitCode to virusScan.Pending', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [{ $type: 'modelClamScan', output: { exitCode: null, output: null } }],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Pending);
    });

    it('forces pickleScan to Danger when dangerous imports are present, regardless of exitCode', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelPickleScan',
              output: {
                exitCode: 0,
                dangerousImports: ['os,system'],
                globalImports: [],
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Danger);
      expect(updateCall.data.pickleScanMessage).toContain('Dangerous import detected');
    });

    it('maps pickleScan with no dangerous imports through exitCodeToScanResult', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelPickleScan',
              output: { exitCode: 0, dangerousImports: [], globalImports: [] },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Success);
    });

    it('translates orchestrator hash field names to ModelHashType keys', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelHash',
              output: {
                sha256: 'sha',
                autoV1: 'av1',
                autoV2: 'av2',
                autoV3: 'av3',
                blake3: 'b3',
                crc32: 'crc',
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      expect(mockDbWrite.modelFileHash.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          { fileId: 1, type: ModelHashType.SHA256, hash: 'sha' },
          { fileId: 1, type: ModelHashType.AutoV1, hash: 'av1' },
          { fileId: 1, type: ModelHashType.AutoV2, hash: 'av2' },
          { fileId: 1, type: ModelHashType.AutoV3, hash: 'av3' },
          { fileId: 1, type: ModelHashType.BLAKE3, hash: 'b3' },
          { fileId: 1, type: ModelHashType.CRC32, hash: 'crc' },
        ]),
      });
    });

    it('skips hash entries with null/empty values', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelHash',
              output: { sha256: 'sha', autoV1: null, autoV2: '', autoV3: undefined },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const createManyCall = mockDbWrite.modelFileHash.createMany.mock.calls[0][0];
      expect(createManyCall.data).toEqual([
        { fileId: 1, type: ModelHashType.SHA256, hash: 'sha' },
      ]);
    });

    it('maps clamScan status "clean" to virusScan.Success even when exitCode is null', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelClamScan',
              output: {
                exitCode: null,
                output: 'scan summary text',
                status: 'clean',
                infected: false,
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Success);
      expect(updateCall.data.virusScanMessage).toBeNull();
    });

    it('maps clamScan infected=true to virusScan.Danger and surfaces output message', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelClamScan',
              output: {
                exitCode: null,
                output: 'EICAR signature detected',
                status: 'infected',
                infected: true,
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Danger);
      expect(updateCall.data.virusScanMessage).toBe('EICAR signature detected');
    });

    it('treats pickleScan skipped=true (safetensors) as Success with null message', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelPickleScan',
              output: {
                exitCode: null,
                output: 'safetensors',
                globalImports: [],
                dangerousImports: [],
                status: 'skippedSafetensors',
                dangerousImportsFound: false,
                skipped: true,
                skipReason: 'safetensors-extension',
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Success);
      expect(updateCall.data.pickleScanMessage).toBeNull();
    });

    it('forces pickleScan to Danger when dangerousImportsFound is true', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelPickleScan',
              output: {
                exitCode: null,
                status: 'dangerous',
                dangerousImportsFound: true,
                skipped: false,
                dangerousImports: ['os,system'],
                globalImports: [],
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Danger);
      expect(updateCall.data.pickleScanMessage).toContain('Dangerous import detected');
    });

    it('maps pickleScan status "clean" to Success with examined imports message', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelPickleScan',
              output: {
                exitCode: null,
                status: 'clean',
                dangerousImportsFound: false,
                skipped: false,
                dangerousImports: [],
                globalImports: [],
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Success);
      expect(updateCall.data.pickleScanMessage).toBe('No Pickle imports');
    });

    it('parses metadata JSON and stores it in headerData', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelParseMetadata',
              output: { metadata: JSON.stringify({ key: 'value', number: 42 }) },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.headerData).toEqual({ key: 'value', number: 42 });
    });

    it('parses ss_tag_frequency stringified JSON into an object when valid', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelParseMetadata',
              output: {
                metadata: JSON.stringify({
                  ss_tag_frequency: JSON.stringify({ tagA: 5, tagB: 3 }),
                  other: 'stuff',
                }),
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.headerData.ss_tag_frequency).toEqual({ tagA: 5, tagB: 3 });
      expect(updateCall.data.headerData.other).toBe('stuff');
    });

    it('leaves ss_tag_frequency as a string when its inner JSON parse fails', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelParseMetadata',
              output: {
                metadata: JSON.stringify({ ss_tag_frequency: 'not json' }),
              },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.headerData.ss_tag_frequency).toBe('not json');
    });

    it('silently skips headerData when the metadata payload is not valid JSON', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelParseMetadata',
              output: { metadata: 'not-json{' },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.headerData).toBeUndefined();
    });

    it('persists a normalized rawScanResult envelope tagged with source=orchestrator', async () => {
      const steps = [{ $type: 'modelClamScan', output: { exitCode: 0, output: null } }];
      mockGetWorkflow.mockResolvedValue({
        data: { metadata: { fileId: 1 }, steps },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-abc', type: 'workflow', status: 'succeeded' })
      );

      const updateCall = mockDbWrite.modelFile.update.mock.calls[0][0];
      expect(updateCall.data.rawScanResult).toEqual({
        source: 'orchestrator',
        workflowId: 'wf-abc',
        steps,
      });
    });
  });

  // ==========================================================================
  // rescanModel — flag-branched dispatch. A wrong branch silently routes to
  // the wrong scanner, so cover both paths and the soft-deleted edge.
  // ==========================================================================
  describe('rescanModel', () => {
    beforeEach(() => {
      mockDbWrite.modelFile.findMany.mockReset().mockResolvedValue([]);
      mockDbWrite.modelFile.updateMany.mockReset().mockResolvedValue({ count: 0 });
      mockIsFlipt.mockReset();
      mockCreateModelFileScanRequest.mockReset();
      mockRequestScannerTasks.mockReset();
    });

    describe('orchestrator path (flag ON)', () => {
      beforeEach(() => {
        mockIsFlipt.mockResolvedValue(true);
      });

      it('returns { sent: 0, failed: 0 } when the model has no files', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([]);

        const result = await rescanModel({ id: 1 });

        expect(result).toEqual({ sent: 0, failed: 0 });
        expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
        expect(mockRequestScannerTasks).not.toHaveBeenCalled();
      });

      it('queries with the orchestrator-shaped select (includes modelVersion + model)', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([]);

        await rescanModel({ id: 1 });

        const findManyArgs = mockDbWrite.modelFile.findMany.mock.calls[0][0];
        expect(findManyArgs.select).toMatchObject({
          id: true,
          url: true,
          modelVersion: expect.objectContaining({
            select: expect.objectContaining({
              baseModel: true,
              model: expect.any(Object),
            }),
          }),
        });
      });

      it('routes every file through createModelFileScanRequest (NOT requestScannerTasks)', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          {
            id: 1,
            url: 's3://k1',
            modelVersion: {
              id: 10,
              baseModel: 'SD 1.5',
              model: { id: 100, type: 'Checkpoint' },
            },
          },
          {
            id: 2,
            url: 's3://k2',
            modelVersion: { id: 20, baseModel: 'SDXL', model: { id: 200, type: 'LORA' } },
          },
        ]);
        mockCreateModelFileScanRequest.mockResolvedValue(undefined);

        const result = await rescanModel({ id: 999 });

        expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(2);
        expect(mockRequestScannerTasks).not.toHaveBeenCalled();
        expect(mockCreateModelFileScanRequest).toHaveBeenCalledWith({
          fileId: 1,
          modelVersionId: 10,
          modelId: 100,
          modelType: 'Checkpoint',
          baseModel: 'SD 1.5',
          priority: 'low',
        });
        expect(result).toEqual({ sent: 2, failed: 0 });
      });

      it('skips files with a null modelVersion (orphaned/soft-deleted) without crashing', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          { id: 1, url: 's3://k1', modelVersion: null },
          {
            id: 2,
            url: 's3://k2',
            modelVersion: { id: 20, baseModel: 'SDXL', model: { id: 200, type: 'LORA' } },
          },
        ]);
        mockCreateModelFileScanRequest.mockResolvedValue(undefined);

        const result = await rescanModel({ id: 1 });

        expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ sent: 1, failed: 1 });
      });

      it('counts createModelFileScanRequest throws as failures, not crashes', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          {
            id: 1,
            url: 's3://k1',
            modelVersion: {
              id: 10,
              baseModel: 'SD 1.5',
              model: { id: 100, type: 'Checkpoint' },
            },
          },
          {
            id: 2,
            url: 's3://k2',
            modelVersion: { id: 20, baseModel: 'SDXL', model: { id: 200, type: 'LORA' } },
          },
        ]);
        mockCreateModelFileScanRequest
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('orchestrator down'));

        const result = await rescanModel({ id: 1 });

        expect(result).toEqual({ sent: 1, failed: 1 });
      });

      it('marks scanRequestedAt=now only for files that were sent', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          {
            id: 1,
            url: 's3://k1',
            modelVersion: {
              id: 10,
              baseModel: 'SD 1.5',
              model: { id: 100, type: 'Checkpoint' },
            },
          },
          { id: 2, url: 's3://k2', modelVersion: null }, // skipped
        ]);
        mockCreateModelFileScanRequest.mockResolvedValue(undefined);

        await rescanModel({ id: 1 });

        expect(mockDbWrite.modelFile.updateMany).toHaveBeenCalledWith({
          where: { id: { in: [1] } },
          data: { scanRequestedAt: expect.any(Date) },
        });
      });

      it('does NOT call updateMany when no files were sent', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          { id: 1, url: 's3://k1', modelVersion: null },
        ]);

        await rescanModel({ id: 1 });

        expect(mockDbWrite.modelFile.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('legacy path (flag OFF)', () => {
      beforeEach(() => {
        mockIsFlipt.mockResolvedValue(false);
      });

      it('queries with the slim legacy select (only id + url)', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([]);

        await rescanModel({ id: 1 });

        const findManyArgs = mockDbWrite.modelFile.findMany.mock.calls[0][0];
        expect(findManyArgs.select).toEqual({ id: true, url: true });
      });

      it('routes every file through requestScannerTasks (NOT createModelFileScanRequest)', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          { id: 1, url: 's3://k1' },
          { id: 2, url: 's3://k2' },
        ]);
        mockRequestScannerTasks.mockResolvedValue('sent');

        const result = await rescanModel({ id: 1 });

        expect(mockRequestScannerTasks).toHaveBeenCalledTimes(2);
        expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
        expect(mockRequestScannerTasks).toHaveBeenCalledWith({
          file: { id: 1, url: 's3://k1' },
          tasks: ['Hash', 'Scan', 'ParseMetadata'],
          lowPriority: true,
        });
        expect(result).toEqual({ sent: 2, failed: 0 });
      });

      it('counts non-"sent" return values as failed', async () => {
        mockDbWrite.modelFile.findMany.mockResolvedValue([
          { id: 1, url: 's3://k1' },
          { id: 2, url: 's3://k2' },
          { id: 3, url: 's3://k3' },
        ]);
        mockRequestScannerTasks
          .mockResolvedValueOnce('sent')
          .mockResolvedValueOnce('not-found')
          .mockResolvedValueOnce('error');

        const result = await rescanModel({ id: 1 });

        expect(result).toEqual({ sent: 1, failed: 2 });
      });
    });
  });

  // ==========================================================================
  // unpublishBlockedModel — used by retroactive-hash-blocking and (when D2 is
  // re-enabled) by applyScanOutcome itself.
  // ==========================================================================
  describe('unpublishBlockedModel', () => {
    beforeEach(() => {
      mockDbWrite.modelVersion.findUnique.mockReset().mockResolvedValue(null);
      mockUnpublishModelById.mockReset().mockResolvedValue({});
    });

    it('no-ops silently when the modelVersion is missing', async () => {
      mockDbWrite.modelVersion.findUnique.mockResolvedValue(null);

      await unpublishBlockedModel(999);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
    });

    it('no-ops when the version exists but its model is missing (defensive)', async () => {
      mockDbWrite.modelVersion.findUnique.mockResolvedValue({ id: 1, model: null });

      await unpublishBlockedModel(1);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
    });

    it('unpublishes the parent model with reason="duplicate" via system user (-1)', async () => {
      mockDbWrite.modelVersion.findUnique.mockResolvedValue({
        id: 50,
        model: { id: 500, meta: { someExisting: 'meta' } },
      });

      await unpublishBlockedModel(50);

      expect(mockUnpublishModelById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 500,
          reason: 'duplicate',
          userId: -1,
          isModerator: true,
          meta: { someExisting: 'meta' },
          customMessage: expect.stringContaining('blocked hash'),
        })
      );
    });

    it('coerces null/missing meta to an empty object before passing along', async () => {
      mockDbWrite.modelVersion.findUnique.mockResolvedValue({
        id: 50,
        model: { id: 500, meta: null },
      });

      await unpublishBlockedModel(50);

      expect(mockUnpublishModelById).toHaveBeenCalledWith(
        expect.objectContaining({ meta: {} })
      );
    });
  });
});
