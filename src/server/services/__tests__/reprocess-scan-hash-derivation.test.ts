import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Behavioural half of the `ModelFileHash` writer seam (structural half:
 * model-file-hash-writers.test.ts).
 *
 * `/api/mod/reprocess-scan` replays `ModelFile.rawScanResult` — the orchestrator's original
 * payload, where AutoV3 is still 64 chars and SHA256_12 does not exist. Since migration
 * 20260819010000 drops `truncate_autov3_hash`, nothing downstream repairs that: a version of this
 * endpoint that skipped `normalizeScanHashes()` would write a full-length AutoV3 and no
 * SHA256_12, every row would be valid, every test that only counts rows would stay green, and
 * every LoRA it touched would silently stop resolving.
 *
 * So this asserts the exact `{type}={hash}` set handed to `createMany`, against literal expected
 * values — not against `normalizeScanHashes(input)`, which would just restate the implementation.
 */

// reprocess-scan imports the real model-file-scan.service for normalizeScanHashes. That module's
// import graph reaches clickhouse/redis/search-index/flipt at load time; stub the edges so the
// helper under test is the only real code in the path.
vi.mock('@civitai/client', () => ({
  getWorkflow: vi.fn(),
  submitWorkflow: vi.fn(),
  createCivitaiClient: vi.fn(),
  WorkflowStatus: { Pending: 'Pending', Running: 'Running', Completed: 'Completed' },
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: vi.fn(),
  ModelFileScanSubmissionError: class extends Error {},
}));
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

// ModEndpoint wraps the handler in a moderator session check. Unwrap it — this file is about the
// hash rows, and auth is covered by moderator-endpoint.test.ts.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/mod/reprocess-scan';

const mockDbWrite = dbMock.dbWrite;

// Pairwise distinct, and distinct from every constant the assertions name (12, 64, the all-zero
// sentinel), so a mutant that truncates the wrong field, hardcodes a literal width, or copies one
// hash into another's row cannot land on an expected value by accident.
const SHA256_FIXTURE = '0123456789abcdef'.repeat(4); // 64 chars; [0:12] = '0123456789ab'
const AUTOV3_FIXTURE = 'fedcba9876543210'.repeat(4); // 64 chars; [0:12] = 'fedcba987654'
const AUTOV1_FIXTURE = '1111aaaa2222bbbb';
const AUTOV2_FIXTURE = '3333cccc44';
const BLAKE3_FIXTURE = '5555dddd6666eeee';
const CRC32_FIXTURE = '77778888';

/** The orchestrator's own key casing, as stored in rawScanResult. */
const RAW_HASHES = {
  sha256: SHA256_FIXTURE,
  autoV1: AUTOV1_FIXTURE,
  autoV2: AUTOV2_FIXTURE,
  autoV3: AUTOV3_FIXTURE,
  blake3: BLAKE3_FIXTURE,
  crc32: CRC32_FIXTURE,
};

const FILE_ID = 4242;

const runHandler = async () => {
  const req = {
    method: 'GET',
    query: { modelFileIds: String(FILE_ID) },
  } as unknown as NextApiRequest;
  const json = vi.fn().mockReturnThis();
  const res = { status: vi.fn().mockReturnThis(), json } as unknown as NextApiResponse;
  await handler(req, res);
  return { json };
};

/** `{type}={hash}` for every row the endpoint handed createMany, sorted. */
const hashRowsWritten = () => {
  const calls = mockDbWrite.modelFileHash.createMany.mock.calls;
  expect(calls, 'the endpoint never wrote any hash rows').toHaveLength(1);
  const { data } = calls[0][0] as { data: { fileId: number; type: string; hash: string }[] };
  return data.map(({ type, hash }) => `${type}=${hash}`).sort();
};

describe('/api/mod/reprocess-scan hash derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      { id: FILE_ID, rawScanResult: { hashes: RAW_HASHES } },
    ]);
  });

  it('writes the derived hash set, not the raw orchestrator payload', async () => {
    await runHandler();

    // Literal expectations. AutoV3 is truncated to the width A1111 writes; SHA256_12 is derived
    // and is a value the payload never contained; everything else passes through byte-for-byte.
    expect(hashRowsWritten()).toEqual(
      [
        `SHA256=${SHA256_FIXTURE}`,
        'SHA256_12=0123456789ab',
        'AutoV3=fedcba987654',
        `AutoV1=${AUTOV1_FIXTURE}`,
        `AutoV2=${AUTOV2_FIXTURE}`,
        `BLAKE3=${BLAKE3_FIXTURE}`,
        `CRC32=${CRC32_FIXTURE}`,
      ].sort()
    );
  });

  it('never stores the full-length AutoV3 the orchestrator sent', async () => {
    await runHandler();
    const rows = hashRowsWritten();

    // Assert the STATE of the AutoV3 row, not the absence of a word: a `not.toContain(64-char)`
    // check passes for a row that is missing entirely, which is a different bug with the same
    // symptom downstream.
    expect(rows).toContain('AutoV3=fedcba987654');
    expect(rows).not.toContain(`AutoV3=${AUTOV3_FIXTURE}`);
  });

  it('derives SHA256_12 as sha256[0:12], a value present nowhere in the input', async () => {
    await runHandler();
    const rows = hashRowsWritten();

    expect(rows).toContain('SHA256_12=0123456789ab');
    // The whole point of the type: the value is not any other stored hash, so a writer that omits
    // it leaves the 12-char LoRA references with nothing to match.
    expect(Object.values(RAW_HASHES)).not.toContain('0123456789ab');
  });

  it('leaves the all-zero "file unreachable" sentinel without a derived SHA256_12', async () => {
    // Deriving from the sentinel would give every unreachable file the same 12-char hash and make
    // them match each other. This is the same invariant that exempts the orchestrator writer from
    // the ledger, asserted here on the path that can actually replay a sentinel.
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      { id: FILE_ID, rawScanResult: { hashes: { sha256: '0'.repeat(64) } } },
    ]);
    await runHandler();

    expect(hashRowsWritten()).toEqual([`SHA256=${'0'.repeat(64)}`]);
  });
});
