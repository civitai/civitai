import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const h = vi.hoisted(() => ({
  submitWorkflow: vi.fn(),
  resolveDownloadUrl: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', () => ({ submitWorkflow: h.submitWorkflow }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/delivery-worker', () => ({ resolveDownloadUrl: h.resolveDownloadUrl }));

import {
  requeuePendingTrainingDataScans,
  submitTrainingDataScan,
  submitTrainingDataScanSafe,
} from '~/server/services/training-data-scan.service';

const TARGET = { fileId: 56, modelVersionId: 7, url: 'https://bucket/data.zip' };
const ZIP_BYTES = 2048;

const source = (init: { status?: number; length?: string | null } = {}) =>
  new Response(init.status && init.status >= 400 ? null : 'zipbytes', {
    status: init.status ?? 200,
    headers: init.length === null ? {} : { 'content-length': init.length ?? String(ZIP_BYTES) },
  });

/** Answers the zip read, then the blob upload. */
function orchestratorAnswers({ upload = { id: 'BLOB1' } as object, uploadStatus = 200 } = {}) {
  h.fetch.mockImplementation(async (input: string) => {
    if (input.endsWith('/v2/consumer/blobs'))
      return new Response(JSON.stringify(upload), { status: uploadStatus });
    return source();
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', h.fetch);
  setEnv({
    ORCHESTRATOR_ENDPOINT: 'https://orch.example/',
    ORCHESTRATOR_ACCESS_TOKEN: 'svc-token',
    NEXTAUTH_URL: 'https://civitai.example',
    WEBHOOK_TOKEN: 'hook',
  });
  h.fetch.mockReset();
  h.submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf-1' } });
  h.resolveDownloadUrl.mockReset().mockResolvedValue({ url: 'https://signed/data.zip' });
  dbMock.dbWrite.modelFile.update.mockReset().mockResolvedValue({});
  orchestratorAnswers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEnv();
});

describe('submitTrainingDataScan', () => {
  it('copies the zip to the orchestrator and runs a virus scan on the blob', async () => {
    await submitTrainingDataScan(TARGET);

    expect(h.resolveDownloadUrl).toHaveBeenCalledWith(56, TARGET.url, undefined, {
      caller: 'training-data',
      actor: 'internal',
    });
    const [uploadUrl, upload] = h.fetch.mock.calls[1];
    expect(uploadUrl).toBe('https://orch.example/v2/consumer/blobs');
    expect(upload.headers).toMatchObject({
      Authorization: 'Bearer svc-token',
      'Content-Length': String(ZIP_BYTES),
    });

    const { body } = h.submitWorkflow.mock.calls[0][0];
    const metadata = { fileId: 56, modelVersionId: 7, url: TARGET.url, scan: 'training-data-blob' };
    expect(body.metadata).toEqual(metadata);
    expect(body.steps).toEqual([
      {
        $type: 'modelClamScan',
        name: 'clamScan',
        metadata,
        input: { model: 'urn:air:other:other:orchestrator:blob@BLOB1' },
      },
    ]);
    expect(body.callbacks).toEqual([
      expect.objectContaining({
        url: 'https://civitai.example/api/webhooks/model-file-scan-result?token=hook',
      }),
    ]);
  });

  it.each([
    ['the zip read fails', () => h.fetch.mockResolvedValueOnce(source({ status: 404 }))],
    ['the zip has no length', () => h.fetch.mockResolvedValueOnce(source({ length: null }))],
    ['the zip is empty', () => h.fetch.mockResolvedValueOnce(source({ length: '0' }))],
    ['the upload is refused', () => orchestratorAnswers({ uploadStatus: 500 })],
    ['the upload names no blob', () => orchestratorAnswers({ upload: {} })],
  ])('throws, and submits no scan of nothing, when %s', async (_, fail) => {
    fail();

    await expect(submitTrainingDataScan(TARGET)).rejects.toThrow();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('throws when the scan workflow is not accepted', async () => {
    h.submitWorkflow.mockResolvedValue({ data: undefined });

    await expect(submitTrainingDataScan(TARGET)).rejects.toThrow('not accepted for file 56');
  });

  it('releases the zip read when the copy cannot go ahead', async () => {
    const cancel = vi.fn(async () => undefined);
    h.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Headers(),
      body: { cancel },
    });

    await expect(submitTrainingDataScan(TARGET)).rejects.toThrow('unreadable: 503');
    expect(cancel).toHaveBeenCalled();
  });

  it('submits nothing, and writes no verdict, without an orchestrator token outside production', async () => {
    setEnv({ ORCHESTRATOR_ACCESS_TOKEN: undefined });

    await submitTrainingDataScan(TARGET);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});

describe('submitTrainingDataScanSafe', () => {
  it('logs a failed submit and says so instead of throwing', async () => {
    h.submitWorkflow.mockRejectedValue(new Error('orchestrator down'));

    expect(await submitTrainingDataScanSafe(TARGET, 'test')).toBe(false);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'training-data-scan-submit', op: 'test', fileId: 56 })
    );
  });
});

describe('requeuePendingTrainingDataScans', () => {
  const rows = [
    { id: 1, url: 'https://bucket/1.zip', modelVersionId: 10 },
    { id: 2, url: 'https://bucket/2.zip', modelVersionId: 20 },
  ];

  beforeEach(() => {
    dbMock.dbWrite.modelFile.count.mockReset().mockResolvedValue(1389);
    dbMock.dbWrite.modelFile.findMany.mockReset().mockResolvedValue(rows);
  });

  it('only counts on a dry run', async () => {
    const result = await requeuePendingTrainingDataScans({ limit: 2, dryRun: true });

    expect(result).toEqual({ dryRun: true, total: 1389, page: 2, nextAfterId: 2 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('selects only Pending Training Data zips that have bytes, after the cursor', async () => {
    await requeuePendingTrainingDataScans({ limit: 2, afterId: 0, dryRun: true });

    const { where, orderBy } = dbMock.dbWrite.modelFile.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      type: 'Training Data',
      virusScanResult: 'Pending',
      sizeKB: { gt: 0 },
      OR: [{ exists: null }, { exists: true }],
      id: { gt: 0 },
    });
    // Not one submitted within the hour, which may still be copying or scanning.
    const [{ OR: notInFlight }] = where.AND;
    expect(notInFlight[0]).toEqual({ scanRequestedAt: null });
    expect(Date.now() - notInFlight[1].scanRequestedAt.lt.getTime()).toBeGreaterThanOrEqual(
      60 * 60_000
    );
    expect(orderBy).toEqual({ id: 'asc' });
  });

  it('submits each zip of the page it claimed and reports the ones that failed', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    h.submitWorkflow.mockImplementation(
      async ({ body }: { body: { metadata: { fileId: number } } }) =>
        body.metadata.fileId === 2 ? { data: undefined } : { data: { id: 'wf-1' } }
    );

    const result = await requeuePendingTrainingDataScans({ limit: 50, dryRun: false });

    expect(h.submitWorkflow).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ submitted: 1, failed: [2], nextAfterId: null });
  });

  it('skips a zip another request claimed first', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 2 }]);

    const result = await requeuePendingTrainingDataScans({ limit: 50, dryRun: false });

    expect(h.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(h.submitWorkflow.mock.calls[0][0].body.metadata.fileId).toBe(2);
    expect(result).toMatchObject({ page: 1, submitted: 1 });
    const [sql, ids] = dbMock.dbWrite.$queryRaw.mock.calls[0];
    expect(sql.join('?')).toMatch(/"scanRequestedAt" IS NULL/);
    expect(ids).toEqual([1, 2]);
  });
});
