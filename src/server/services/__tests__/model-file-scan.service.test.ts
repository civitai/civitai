import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// One local served both clients. Everything this file drives is dbWrite —
// modelFile.findUnique/update (model-file-scan.service:132, :161, :203), modelFileHash.*
// (:171, :213, :214), modelVersion.findUnique (:339, :686), modelFile.updateMany (:670) —
// EXCEPT rescanModel's modelFile.findMany at :616, which is dbRead. One line decides it.
const mockDbWrite = dbMock.dbWrite;
const mockDbRead = dbMock.dbRead;
const mockLogToAxiom = loggingMock.logToAxiom;
const mockSetNxKeepTtlWithEx = redisMock.sysRedis.setNxKeepTtlWithEx;

const {
  mockGetWorkflow,
  mockDeleteFilesForModelVersionCache,
  mockCreateNotification,
  mockModelsSearchIndexQueueUpdate,
  mockDataForModelsCacheRefresh,
  mockCreateModelFileScanRequest,
  mockModelFileScanSubmissionError,
  mockLimitConcurrency,
  mockUnpublishModelById,
  mockCheckMinorHashOnScan,
  mockIsFlipt,
} = vi.hoisted(() => {
  // Test-local copy of the real error class so rescanModel's instanceof
  // check resolves without importing the real orchestrator module.
  class MockModelFileScanSubmissionError extends Error {
    constructor(
      message: string,
      public readonly code: 'not-found' | 'transient',
      public readonly status?: number,
      public readonly orchestratorMessages?: string[]
    ) {
      super(message);
      this.name = 'ModelFileScanSubmissionError';
    }
  }
  return {
    mockGetWorkflow: vi.fn(),
    mockDeleteFilesForModelVersionCache: vi.fn().mockResolvedValue(undefined),
    mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    mockModelsSearchIndexQueueUpdate: vi.fn().mockResolvedValue(undefined),
    mockDataForModelsCacheRefresh: vi.fn().mockResolvedValue(undefined),
    mockCreateModelFileScanRequest: vi.fn(),
    mockModelFileScanSubmissionError: MockModelFileScanSubmissionError,
    // sequential runner so per-file effects assert deterministically
    mockLimitConcurrency: vi.fn(async (tasks: Array<() => Promise<unknown>>) => {
      for (const t of tasks) await t();
    }),
    mockUnpublishModelById: vi.fn().mockResolvedValue({}),
    mockCheckMinorHashOnScan: vi.fn().mockResolvedValue('skipped'),
    mockIsFlipt: vi.fn().mockResolvedValue(true),
  };
});

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

vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: mockDataForModelsCacheRefresh },
}));

vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: mockModelsSearchIndexQueueUpdate },
}));

vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: mockDeleteFilesForModelVersionCache,
  findOfficialFileByHash: vi.fn(),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: mockCreateModelFileScanRequest,
  ModelFileScanSubmissionError: mockModelFileScanSubmissionError,
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

vi.mock('~/server/services/model-version.service', () => ({ addLinkedComponent: vi.fn() }));

vi.mock('~/server/services/minor-hash.service', () => ({
  checkMinorHashOnScan: mockCheckMinorHashOnScan,
  MINOR_HASH_FILE_TYPE: 'Model',
}));

// Default ON so the existing wiring tests exercise the real path; the gate's
// off-state is asserted explicitly below.
// Flag VALUES must be real here, not a single-key stub. The service gates three independent
// things on Flipt (minor-hash auto-flag, strict skip verification, format-mismatch hold), and
// with only one key in this map the others resolve to `undefined` — every gate would then be
// asking about the same flag and a test could not turn one on while leaving another off.
vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: {
    MINOR_HASH_AUTO_FLAG: 'minor-hash-auto-flag',
    SCAN_STRICT_SKIP_VERIFICATION: 'scan-strict-skip-verification',
    SCAN_FORMAT_MISMATCH_HOLD: 'scan-format-mismatch-hold',
  },
}));

/** Turn named flags on and leave every other flag off. */
const onlyFlags = (...on: string[]) =>
  mockIsFlipt.mockImplementation(async (flag: string) => on.includes(flag));

import {
  applyScanOutcome,
  examinePickleImports,
  processModelFileScanResult,
  rescanModel,
  unpublishBlockedModel,
} from '~/server/services/model-file-scan.service';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';
import { findOfficialFileByHash } from '~/server/services/model-file.service';
import { addLinkedComponent } from '~/server/services/model-version.service';
import { constants } from '~/server/common/constants';

// Every hash writer runs through normalizeScanHashes, which DERIVES rows (SHA256_12 from SHA256,
// a truncated AutoV3) on top of what the orchestrator sent. So these assertions name the exact
// set of type=hash pairs written: a new derivation shows up as an unexpected member rather than
// as arithmetic that needs re-doing, and a wrong derivation shows up as a wrong value.
const hashRowsWritten = (callIndex = 0) => {
  const { data } = mockDbWrite.modelFileHash.createMany.mock.calls[callIndex][0] as {
    data: { fileId: number; type: ModelHashType; hash: string }[];
  };
  return data.map(({ fileId, type, hash }) => `${fileId}:${type}=${hash}`).sort();
};

const expectHashRows = (expected: string[], callIndex = 0) =>
  expect(hashRowsWritten(callIndex)).toEqual([...expected].sort());

// Long enough that a slice is observable — 'sha' would make SHA256_12 identical to SHA256.
const SHA256_FIXTURE = 'a'.repeat(60) + 'beef';
const AUTOV3_FIXTURE = 'c'.repeat(60) + 'dead';

describe('model-file-scan.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFlipt.mockResolvedValue(true);
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

      await applyScanOutcome({ fileId: 999, modelVersionId: 42 });

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          name: 'apply-scan-outcome',
          fileId: 999,
          modelVersionId: 42,
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
          [ModelHashType.SHA256]: SHA256_FIXTURE,
          [ModelHashType.AutoV2]: 'auto-1',
        },
      });

      expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
      expect(mockDbWrite.modelFileHash.deleteMany).toHaveBeenCalledWith({
        where: { fileId: 1 },
      });
      expectHashRows([
        `1:${ModelHashType.SHA256}=${SHA256_FIXTURE}`,
        `1:${ModelHashType.SHA256_12}=${SHA256_FIXTURE.slice(0, 12)}`,
        `1:${ModelHashType.AutoV2}=auto-1`,
      ]);
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
      // Default: dedupe key acquired (first delivery for this workflow).
      mockSetNxKeepTtlWithEx.mockResolvedValue(true);
    });

    it('suppresses duplicate callbacks for the same workflowId without side-effects', async () => {
      // Second delivery: dedupe lock already held by first delivery.
      mockSetNxKeepTtlWithEx.mockResolvedValueOnce(false);

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-dup', type: 'workflow', status: 'succeeded' })
      );

      expect(mockSetNxKeepTtlWithEx).toHaveBeenCalledWith(
        'webhooks:model-file-scan:processed:wf-dup',
        '1',
        expect.any(Number)
      );
      // No orchestrator round-trip, no DB writes, no cache busts on duplicate.
      expect(mockGetWorkflow).not.toHaveBeenCalled();
      expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled();
      expect(mockDeleteFilesForModelVersionCache).not.toHaveBeenCalled();
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          name: 'model-file-scan-result',
          workflowId: 'wf-dup',
          duplicate: true,
        }),
        'webhooks'
      );
    });

    it('acquires the dedupe lock on first delivery and proceeds to process the workflow', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1, modelVersionId: 100 },
          steps: [],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-first', type: 'workflow', status: 'succeeded' })
      );

      expect(mockSetNxKeepTtlWithEx).toHaveBeenCalledWith(
        'webhooks:model-file-scan:processed:wf-first',
        '1',
        expect.any(Number)
      );
      expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
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
                sha256: SHA256_FIXTURE,
                autoV1: 'av1',
                autoV2: 'av2',
                autoV3: AUTOV3_FIXTURE,
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

      expectHashRows([
        `1:${ModelHashType.SHA256}=${SHA256_FIXTURE}`,
        `1:${ModelHashType.SHA256_12}=${SHA256_FIXTURE.slice(0, 12)}`,
        `1:${ModelHashType.AutoV1}=av1`,
        `1:${ModelHashType.AutoV2}=av2`,
        `1:${ModelHashType.AutoV3}=${AUTOV3_FIXTURE.slice(0, 12)}`,
        `1:${ModelHashType.BLAKE3}=b3`,
        `1:${ModelHashType.CRC32}=crc`,
      ]);
    });

    it('skips hash entries with null/empty values', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [
            {
              $type: 'modelHash',
              output: { sha256: SHA256_FIXTURE, autoV1: null, autoV2: '', autoV3: undefined },
            },
          ],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      expectHashRows([
        `1:${ModelHashType.SHA256}=${SHA256_FIXTURE}`,
        `1:${ModelHashType.SHA256_12}=${SHA256_FIXTURE.slice(0, 12)}`,
      ]);
    });

    // The scan-request path writes an all-zero SHA256 as a "file unreachable" sentinel; deriving
    // from it would give every unreachable file the same 12-char hash, matching them to each other.
    it('does not derive SHA256_12 from the all-zero sha256 sentinel', async () => {
      mockGetWorkflow.mockResolvedValue({
        data: {
          metadata: { fileId: 1 },
          steps: [{ $type: 'modelHash', output: { sha256: '0'.repeat(64) } }],
        },
      });

      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-1', type: 'workflow', status: 'succeeded' })
      );

      expectHashRows([`1:${ModelHashType.SHA256}=${'0'.repeat(64)}`]);
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

    // This previously used an extension-derived skipReason, which the format-conformance change
    // no longer treats as verified, so it no longer belongs in a test asserting a PASS. The case
    // this test exists for — a genuine skip yields Success with a null message — is preserved by
    // moving it to the byte-verified reason. Both regimes are covered in the
    // 'scan format conformance' block below.
    it('treats a byte-verified pickleScan skip (safetensors) as Success with null message', async () => {
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
                skipReason: 'safetensors-magic',
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
  // rescanModel — orchestrator dispatch. Covers the soft-deleted edge and
  // submission-failure handling.
  // ==========================================================================
  describe('rescanModel', () => {
    beforeEach(() => {
      mockDbRead.modelFile.findMany.mockReset().mockResolvedValue([]);
      mockDbWrite.modelFile.updateMany.mockReset().mockResolvedValue({ count: 0 });
      mockCreateModelFileScanRequest.mockReset();
    });

    it('returns { sent: 0, failed: 0 } when the model has no files', async () => {
      mockDbRead.modelFile.findMany.mockResolvedValue([]);

      const result = await rescanModel({ id: 1 });

      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
    });

    it('queries with the orchestrator-shaped select (includes modelVersion + model)', async () => {
      mockDbRead.modelFile.findMany.mockResolvedValue([]);

      await rescanModel({ id: 1 });

      const findManyArgs = mockDbRead.modelFile.findMany.mock.calls[0][0];
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

    it('routes every file through createModelFileScanRequest', async () => {
      mockDbRead.modelFile.findMany.mockResolvedValue([
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
      expect(mockCreateModelFileScanRequest).toHaveBeenCalledWith({
        fileId: 1,
        modelVersionId: 10,
        modelId: 100,
        modelType: 'Checkpoint',
        baseModel: 'SD 1.5',
        url: 's3://k1',
        priority: 'low',
      });
      expect(result).toEqual({ sent: 2, failed: 0 });
    });

    it('skips files with a null modelVersion (orphaned/soft-deleted) without crashing', async () => {
      mockDbRead.modelFile.findMany.mockResolvedValue([
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
      mockDbRead.modelFile.findMany.mockResolvedValue([
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
      mockDbRead.modelFile.findMany.mockResolvedValue([
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
      mockDbRead.modelFile.findMany.mockResolvedValue([
        { id: 1, url: 's3://k1', modelVersion: null },
      ]);

      await rescanModel({ id: 1 });

      expect(mockDbWrite.modelFile.updateMany).not.toHaveBeenCalled();
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

      expect(mockUnpublishModelById).toHaveBeenCalledWith(expect.objectContaining({ meta: {} }));
    });
  });

  // ==========================================================================
  // applyScanOutcome — post-scan official-match dedup safety net
  // ==========================================================================
  describe('applyScanOutcome — official-match dedup', () => {
    const OFFICIAL = constants.system.officialUserId;

    it('converts a matching non-official upload to a pointer and deletes the row', async () => {
      // file owned by a normal user, a VAE
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 500,
        type: 'VAE',
        modelVersionId: 10,
        modelVersion: { modelId: 1, model: { userId: 999 } },
      });
      vi.mocked(findOfficialFileByHash).mockResolvedValue({
        versionId: 42,
        fileId: 900,
        modelId: 7,
        modelName: 'Boogu VAE',
        versionName: 'v1',
        fileName: 'boogu.vae.safetensors',
        sizeKB: 300_000,
        componentType: 'VAE',
      });

      await applyScanOutcome({
        fileId: 500,
        hashes: { SHA256: 'abc' },
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(addLinkedComponent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 10,
          targetVersionId: 42,
          targetFileId: 900,
          replaceFileId: 500,
          componentType: 'VAE',
          userId: OFFICIAL,
          isModerator: true,
        })
      );
    });

    it('does nothing when the uploader IS official', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 501,
        type: 'VAE',
        modelVersionId: 11,
        modelVersion: { modelId: 2, model: { userId: OFFICIAL } },
      });
      await applyScanOutcome({
        fileId: 501,
        hashes: { SHA256: 'abc' },
        virusScan: { result: ScanResultCode.Success, message: null },
      });
      expect(findOfficialFileByHash).not.toHaveBeenCalled();
      expect(addLinkedComponent).not.toHaveBeenCalled();
    });

    it('skips a primary-typed (main-section) file — cannot delete primary weights', async () => {
      // addLinkedComponent refuses to delete a Model-typed file, so the post-scan
      // dedup never attempts it; the client prevents that case before upload.
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 503,
        type: 'Model',
        modelVersionId: 13,
        modelVersion: { modelId: 4, model: { userId: 999 } },
      });
      await applyScanOutcome({
        fileId: 503,
        hashes: { SHA256: 'abc' },
        virusScan: { result: ScanResultCode.Success, message: null },
      });
      expect(findOfficialFileByHash).not.toHaveBeenCalled();
      expect(addLinkedComponent).not.toHaveBeenCalled();
    });

    it('never throws out of scan finalization when dedup fails', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 502,
        type: 'VAE',
        modelVersionId: 12,
        modelVersion: { modelId: 3, model: { userId: 999 } },
      });
      vi.mocked(findOfficialFileByHash).mockRejectedValue(new Error('boom'));
      await expect(
        applyScanOutcome({
          fileId: 502,
          hashes: { SHA256: 'abc' },
          virusScan: { result: ScanResultCode.Success, message: null },
        })
      ).resolves.toBeUndefined();
      // prove the error path was actually entered (not skipped) before it was swallowed
      expect(findOfficialFileByHash).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // applyScanOutcome — minor-hash-detection wiring
  // ==========================================================================
  describe('applyScanOutcome — minor-hash wiring', () => {
    it('calls checkMinorHashOnScan with the fileId/modelId/userId/sha256 derived from the scanned file', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 700,
        type: 'Model',
        modelVersionId: 30,
        modelVersion: { modelId: 55, model: { userId: 777 } },
      });
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);
      mockDbWrite.$transaction.mockResolvedValue([]);

      await applyScanOutcome({
        fileId: 700,
        hashes: { SHA256: 'deadbeef' },
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockCheckMinorHashOnScan).toHaveBeenCalledWith({
        // the scanned file, not just its model: the clear stamp is time-scoped
        // against this file's createdAt
        fileId: 700,
        modelId: 55,
        userId: 777,
        sha256: 'deadbeef',
      });
    });

    // The kill switch has to hold on the scan path specifically: this is the
    // only auto-flag that fires on live uploads, so if it keeps running after
    // the flag is off, throwing the switch does nothing where it matters most.
    it('does not call checkMinorHashOnScan when the kill switch is off', async () => {
      mockIsFlipt.mockResolvedValue(false);
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 703,
        type: 'Model',
        modelVersionId: 33,
        modelVersion: { modelId: 58, model: { userId: 780 } },
      });
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);
      mockDbWrite.$transaction.mockResolvedValue([]);

      await applyScanOutcome({
        fileId: 703,
        hashes: { SHA256: 'deadbeef' },
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockCheckMinorHashOnScan).not.toHaveBeenCalled();
      // the rest of the scan outcome must still be applied
      expect(mockDbWrite.modelFile.update).toHaveBeenCalled();
    });

    it('does not call checkMinorHashOnScan for a non-Model file type', async () => {
      // The sweep and the review queue both only cover MINOR_HASH_FILE_TYPE, so a
      // match here would auto-flag off-sweep or queue somewhere unreachable. Every
      // other test in this block mocks type: 'Model', which hid the gap.
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 702,
        type: 'Training Data',
        modelVersionId: 32,
        modelVersion: { modelId: 57, model: { userId: 779 } },
      });
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);
      mockDbWrite.$transaction.mockResolvedValue([]);

      await applyScanOutcome({
        fileId: 702,
        hashes: { SHA256: 'deadbeef' },
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockCheckMinorHashOnScan).not.toHaveBeenCalled();
    });

    it('does not call checkMinorHashOnScan when the outcome carries no hashes', async () => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 701,
        type: 'Model',
        modelVersionId: 31,
        modelVersion: { modelId: 56, model: { userId: 778 } },
      });

      await applyScanOutcome({
        fileId: 701,
        virusScan: { result: ScanResultCode.Success, message: null },
      });

      expect(mockCheckMinorHashOnScan).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------------------
  // Regression cover: a file whose contents do not match its declared container format must
  // never be recorded as having passed the scans. Incident record, mechanism and measurements
  // are in the internal ticket — deliberately not restated here.
  // -------------------------------------------------------------------------------------
  describe('scan format conformance', () => {
    function makeReq(body: unknown) {
      return { body } as unknown as Parameters<typeof processModelFileScanResult>[0];
    }

    // Any skip reason NOT in the byte-verified set. The specific legacy strings are an
    // implementation detail of the scanner build and are deliberately not named here.
    const LEGACY_UNVERIFIED_SKIP_REASON = 'legacy-unverified-skip';

    const pickleStep = (output: Record<string, unknown>) => ({
      $type: 'modelPickleScan',
      output,
    });

    /** The pickle step exactly as the scanner emits it for a declared/actual disagreement. */
    const formatMismatchOutput = {
      exitCode: 2,
      status: 'ParseError',
      skipped: false,
      skipReason: 'format-mismatch',
      output:
        "Declared format 'Safetensors' does not match file contents (detected: Unknown). " +
        'The file does not carry a valid header for the container type it claims to be.',
      globalImports: [],
      dangerousImports: [],
      dangerousImportsFound: false,
    };

    async function runWithSteps(steps: unknown[]) {
      mockGetWorkflow.mockResolvedValue({
        data: { metadata: { fileId: 1, modelVersionId: 100 }, steps },
      });
      await processModelFileScanResult(
        makeReq({ workflowId: 'wf-fmt', type: 'workflow', status: 'succeeded' })
      );
      return mockDbWrite.modelFile.update.mock.calls[0][0];
    }

    beforeEach(() => {
      mockDbWrite.modelFile.findUnique.mockResolvedValue({
        id: 1,
        modelVersionId: 100,
        modelVersion: { modelId: 200, model: { userId: 42 } },
      });
      mockDbWrite.modelFile.update.mockResolvedValue({});
      mockDbWrite.$transaction.mockResolvedValue([]);
      mockDbWrite.modelFileHash.findMany.mockResolvedValue([]);
      mockDbWrite.model.findUnique.mockResolvedValue({
        id: 200,
        name: 'Test Model',
        meta: {},
        userId: 42,
        status: 'Published',
      });
      mockSetNxKeepTtlWithEx.mockResolvedValue(true);
    });

    it('a format mismatch is never recorded as a clean pickle scan', async () => {
      const updateCall = await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(updateCall.data.pickleScanResult).not.toBe(ScanResultCode.Success);
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Error);
    });

    it('keeps the scanner explanation in rawScanResult, not in the public message', async () => {
      // The detail must survive for forensics and for the moderator-facing log, but NOT in
      // pickleScanMessage, which the public v1 API serves. Both halves asserted together so a
      // future change cannot quietly move it from one to the other.
      const updateCall = await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(JSON.stringify(updateCall.data.rawScanResult)).toContain(
        'does not match file contents'
      );
      expect(updateCall.data.pickleScanMessage).not.toContain('does not match file contents');
    });

    it('holds the model for moderator review, without issuing a violation strike', async () => {
      onlyFlags('scan-format-mismatch-hold');

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 200,
          isModerator: true,
          // Hold, not a strike: reversible and queued for a human.
          reason: 'other',
          meta: expect.objectContaining({ needsReview: true }),
        })
      );
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42, key: 'model-format-mismatch:200:1' })
      );
    });

    it('does not hold when the kill switch is off', async () => {
      onlyFlags(); // every flag off

      const updateCall = await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      // The recorded verdict is independent of the flag — that is what closes the bypass.
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Error);
    });

    it('does not re-hold a model a moderator has already taken down', async () => {
      onlyFlags('scan-format-mismatch-hold');
      mockDbWrite.model.findUnique.mockResolvedValue({
        id: 200,
        name: 'Test Model',
        meta: {},
        userId: 42,
        status: 'UnpublishedViolation',
      });

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
    });

    it('leaves a byte-verified safetensors skip passing, and does not hold it', async () => {
      // The false-positive control: the overwhelming majority of real uploads are genuine
      // safetensors, and under the new scanner they arrive with this skipReason.
      const updateCall = await runWithSteps([
        pickleStep({
          exitCode: 0,
          status: 'SkippedSafetensors',
          skipped: true,
          skipReason: 'safetensors-magic',
          globalImports: [],
          dangerousImports: [],
          dangerousImportsFound: false,
        }),
      ]);

      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Success);
      expect(mockUnpublishModelById).not.toHaveBeenCalled();
    });

    it('a legacy metadata-based skip still passes while strict verification is off', async () => {
      // Deployment-ordering guard: until SCAN_STRICT_SKIP_VERIFICATION is flipped on, a skip
      // reason this build does not recognize must keep passing, or shipping the web app ahead
      // of the scanner fleet would flag ordinary uploads. See the flag's note.
      onlyFlags(); // strict verification OFF

      const updateCall = await runWithSteps([
        pickleStep({
          exitCode: 0,
          status: 'SkippedSafetensors',
          skipped: true,
          skipReason: LEGACY_UNVERIFIED_SKIP_REASON,
          globalImports: [],
          dangerousImports: [],
          dangerousImportsFound: false,
        }),
      ]);

      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Success);
    });

    it('a legacy metadata-based skip stops passing once strict verification is on', async () => {
      onlyFlags('scan-strict-skip-verification');

      const updateCall = await runWithSteps([
        pickleStep({
          exitCode: 0,
          status: 'SkippedSafetensors',
          skipped: true,
          skipReason: LEGACY_UNVERIFIED_SKIP_REASON,
          globalImports: [],
          dangerousImports: [],
          dangerousImportsFound: false,
        }),
      ]);

      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Error);
    });

    it('ClamAV limits-exceeded is Error, never Success and never Danger', async () => {
      // A >4 GB file ClamAV refused to open. Not clean (nothing was read) and not infected
      // (nothing was found) — and NOT Pending, which would re-queue it to be retried forever.
      const updateCall = await runWithSteps([
        {
          $type: 'modelClamScan',
          output: {
            exitCode: 2,
            status: 'Error',
            infected: false,
            limitsExceeded: true,
            maxScanSizeMb: 4000,
            output: 'Heuristics.Limits.Exceeded FOUND',
          },
        },
      ]);

      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Error);
    });

    it('ClamAV limits-exceeded is Error even when the status is unrecognized', async () => {
      // KILLING FIXTURE for the limitsExceeded guard. The other limits test also sets
      // status:'Error', which independently reaches Error via status.includes('error') — so
      // deleting the guard leaves that test green and the guard untested. This payload has NO
      // status, which is exactly the case the guard exists for: an unrecognized status becomes
      // null at the orchestrator, the code falls through to exitCodeToScanResult, and a limits
      // bail-out exits 1 — which would score as Danger, a false virus detection.
      const updateCall = await runWithSteps([
        {
          $type: 'modelClamScan',
          output: { exitCode: 1, infected: false, limitsExceeded: true },
        },
      ]);

      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Error);
      expect(updateCall.data.virusScanResult).not.toBe(ScanResultCode.Danger);
    });

    it('a byte-verified GGUF skip passes under strict verification', async () => {
      // KILLING FIXTURE for the gguf-magic member of BYTE_VERIFIED_SKIP_REASONS. Without this,
      // narrowing the set to just safetensors-magic marks every legitimate GGUF upload Error
      // and no test notices.
      onlyFlags('scan-strict-skip-verification');

      const updateCall = await runWithSteps([
        pickleStep({
          exitCode: 0,
          status: 'SkippedGguf',
          skipped: true,
          skipReason: 'gguf-magic',
          globalImports: [],
          dangerousImports: [],
          dangerousImportsFound: false,
        }),
      ]);

      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Success);
    });

    it('a skipped-* STATUS with no skipped flag is not a pass under strict verification', async () => {
      // KILLING FIXTURE for the status.startsWith('skipped') branch. Reachable on in-flight
      // legacy workflows where `skipped` is unset but the status string still says skipped —
      // the same "we did not look" answer, and previously always Success.
      onlyFlags('scan-strict-skip-verification');

      const updateCall = await runWithSteps([
        pickleStep({
          exitCode: 0,
          status: 'skippedSafetensors',
          globalImports: [],
          dangerousImports: [],
          dangerousImportsFound: false,
        }),
      ]);

      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Error);
    });

    it('blocks a Draft model from being published, via a flag that is actually enforced', async () => {
      // 🔴 The guard against writing an INERT flag. A previous revision set meta.needsReview and
      // called that "putting it in front of a moderator". It was neither: /moderator/models
      // filters status [UnpublishedViolation, Published] so a Draft never appears, AND the
      // publish handler destructures needsReview out of meta before writing it back — the flag
      // was erased by the very action it was meant to guard. `cannotPublish` is the one the
      // publish path actually throws on.
      onlyFlags('scan-format-mismatch-hold');
      mockDbWrite.model.findUnique.mockResolvedValue({
        id: 200,
        name: 'Test Model',
        meta: {},
        userId: 42,
        status: 'Draft',
      });

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      const sql = mockDbWrite.$executeRaw.mock.calls[0][0];
      expect(sql.join('?')).toContain('cannotPublish');
      expect(sql.join('?')).not.toContain('needsReview');
    });

    it('logs a mismatch even when the enforcement flag is OFF', async () => {
      // The rollout plan is "flip the flag, then watch". That is impossible without telemetry
      // from BEFORE the flip. Detection is ungated; only enforcement is gated.
      onlyFlags(); // every flag off

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'scan-format-mismatch' }),
        'webhooks'
      );
      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    });

    it('does not touch meta on an already-unpublished model', async () => {
      // 🔴 Stamping needsReview on an UnpublishedViolation model DISABLES the creator's
      // "Request a Review" button, so a background rescan of an already-actioned model would
      // silently remove its owner's only route of appeal. The log is the whole action here.
      onlyFlags('scan-format-mismatch-hold');
      mockDbWrite.model.findUnique.mockResolvedValue({
        id: 200,
        name: 'Test Model',
        meta: {},
        userId: 42,
        status: 'UnpublishedViolation',
      });

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
      expect(mockDbWrite.model.update).not.toHaveBeenCalled();
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'scan-format-mismatch',
          modelStatus: 'UnpublishedViolation',
        }),
        'webhooks'
      );
    });

    it('holds a Scheduled model, not only a Published one', async () => {
      // KILLING FIXTURE for the Scheduled arm of the allow-list. Every other fixture in this
      // block uses Published/Draft/UnpublishedViolation, so dropping `|| Scheduled` previously
      // left the suite fully green while silently ceasing to hold scheduled models.
      onlyFlags('scan-format-mismatch-hold');
      mockDbWrite.model.findUnique.mockResolvedValue({
        id: 200,
        name: 'Test Model',
        meta: {},
        userId: 42,
        status: 'Scheduled',
      });

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).toHaveBeenCalled();
    });

    it('sends the scanner explanation to the operator log, not the public constant', async () => {
      // The log is the only place a moderator can see WHICH format was declared and what was
      // detected. An earlier revision passed the public fixed string here, leaving the queue
      // with nothing actionable.
      onlyFlags('scan-format-mismatch-hold');

      await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'scan-format-mismatch',
          detail: expect.stringContaining('does not match file contents'),
        }),
        'webhooks'
      );
    });

    it('does not hold a Draft model', async () => {
      // Scans are driven with no model-status predicate and models are Draft during the upload
      // wizard, so this is the ordinary case. Holding one would push a never-published draft to
      // a mod-only status and lock its own creator out of it.
      onlyFlags('scan-format-mismatch-hold');
      mockDbWrite.model.findUnique.mockResolvedValue({
        id: 200,
        name: 'Test Model',
        meta: {},
        userId: 42,
        status: 'Draft',
      });

      const updateCall = await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(mockUnpublishModelById).not.toHaveBeenCalled();
      expect(mockCreateNotification).not.toHaveBeenCalled();
      // The verdict is still recorded — only the side effect is withheld.
      expect(updateCall.data.pickleScanResult).toBe(ScanResultCode.Error);
    });

    it('does not leak the detector verdict into the public scan message', async () => {
      // pickleScanMessage is served by the public v1 model-versions API, so operator-facing
      // detail must not appear in it.
      const updateCall = await runWithSteps([pickleStep(formatMismatchOutput)]);

      expect(updateCall.data.pickleScanMessage).not.toContain('detected');
      expect(updateCall.data.pickleScanMessage).not.toContain('Safetensors');
      expect(updateCall.data.pickleScanMessage).toBe(
        'File format could not be verified. This file is under review.'
      );
    });

    it('a normal clean ClamAV pass is still Success', async () => {
      const updateCall = await runWithSteps([
        {
          $type: 'modelClamScan',
          output: { exitCode: 0, status: 'clean', infected: false, limitsExceeded: false },
        },
      ]);

      expect(updateCall.data.virusScanResult).toBe(ScanResultCode.Success);
    });
  });
});
