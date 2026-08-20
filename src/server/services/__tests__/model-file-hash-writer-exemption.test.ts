import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The one `ModelFileHash` writer that does NOT call `normalizeScanHashes()`.
 *
 * `createModelFileScanRequest`'s dev-only skip (`!isProd && !ORCHESTRATOR_ACCESS_TOKEN`) upserts a
 * "file unreachable" sentinel. It is exempt from the ledger in model-file-hash-writers.test.ts —
 * but not because it is dev-only. It is exempt because that sentinel is a FIXED POINT of
 * `normalizeScanHashes()`: the helper suppresses SHA256_12 derivation for an all-zero SHA256
 * (deriving would give every unreachable file the same 12-char hash, matching each other), and
 * the payload carries no AutoV3 to truncate. Calling the helper there would change nothing.
 *
 * That is a claim about TWO modules at once, and each has its own test file where the claim is
 * invisible: orchestrator.service's tests never load the helper, and the helper's tests never see
 * the real sentinel. So this file loads both and asserts the relationship — it goes red if the
 * sentinel changes shape, if the all-zero guard is dropped from the helper, or if the writer
 * starts storing a second hash type.
 */

const { mockSubmitWorkflow } = vi.hoisted(() => ({
  mockSubmitWorkflow: vi.fn(),
}));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  getWorkflow: vi.fn(),
  createCivitaiClient: vi.fn(),
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
// --- orchestrator.service edges --------------------------------------------
vi.mock('~/shared/utils/air', () => ({ stringifyAIR: vi.fn().mockReturnValue('urn:air:x') }));
vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: vi.fn().mockResolvedValue({ url: 'https://cdn.example/file' }),
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/env/other', () => ({ isProd: false }));
vi.mock('~/env/server', () => ({
  env: {
    ORCHESTRATOR_ACCESS_TOKEN: undefined,
    NEXTAUTH_URL: 'https://civitai.test',
    WEBHOOK_TOKEN: 'wh-token',
  },
}));

// --- model-file-scan.service edges (normalizeScanHashes itself stays real) --
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ addLinkedComponent: vi.fn() }));
vi.mock('~/server/services/minor-hash.service', () => ({
  checkMinorHashOnScan: vi.fn(),
  MINOR_HASH_FILE_TYPE: 'Model',
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(true),
  FLIPT_FEATURE_FLAGS: { MINOR_HASH_AUTO_FLAG: 'minor-hash-auto-flag' },
}));

// Deliberately NOT mocked, and the reason this file exists: both reals, loaded together.
import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';
import { normalizeScanHashes } from '~/server/services/model-file-scan.service';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbWrite = dbMock.dbWrite;
dbMock.dbWrite.modelFile.update.mockResolvedValue({});
dbMock.dbWrite.modelFileHash.upsert.mockResolvedValue({});

const INPUT = {
  fileId: 77,
  modelVersionId: 10,
  modelId: 100,
  modelType: 'Checkpoint' as const,
  baseModel: 'SD 1.5',
  url: 's3://bucket/key.safetensors',
};

/** The exact row the dev-skip writer hands the database. */
const sentinelWritten = () => {
  const calls = mockDbWrite.modelFileHash.upsert.mock.calls;
  expect(calls, 'the dev-skip path wrote no hash row at all').toHaveLength(1);
  const { create } = calls[0][0] as {
    create: { fileId: number; type: ModelHashType; hash: string };
  };
  return create;
};

describe('the ledger-exempt ModelFileHash writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.modelFile.update.mockResolvedValue({});
    mockDbWrite.modelFileHash.upsert.mockResolvedValue({});
  });

  it('writes exactly one row: the all-zero SHA256 sentinel', async () => {
    await createModelFileScanRequest(INPUT);

    // Identity, not a keyword: the type AND the exact hash. A `hash.includes('0')` style check
    // would be satisfied by any hex hash containing a zero.
    expect(sentinelWritten()).toEqual({
      fileId: INPUT.fileId,
      type: 'SHA256',
      hash: '0'.repeat(64),
    });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('writes a payload that normalizeScanHashes leaves untouched — the exemption itself', async () => {
    await createModelFileScanRequest(INPUT);
    const { type, hash } = sentinelWritten();

    const asScanHashes = { [type]: hash } as Partial<Record<ModelHashType, string>>;
    // Fixed point: routing this writer through the helper would produce the same rows it already
    // writes. That is the whole justification for leaving it out of the normalizing set.
    expect(normalizeScanHashes(asScanHashes)).toEqual({ SHA256: '0'.repeat(64) });
  });

  it('would NOT be exempt if the sentinel were a real hash (control for the case above)', () => {
    // The assertion above is only meaningful if normalizeScanHashes can move a SHA256-only
    // payload at all. Feed it a value the all-zero guard cannot match and watch the output grow —
    // without this, a helper that had been gutted to `return {...hashes}` would pass silently.
    const realHash = '0123456789abcdef'.repeat(4);
    expect(
      normalizeScanHashes({ SHA256: realHash } as Partial<Record<ModelHashType, string>>)
    ).toEqual({ SHA256: realHash, SHA256_12: '0123456789ab' });
  });
});
