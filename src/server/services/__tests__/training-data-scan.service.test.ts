import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const h = vi.hoisted(() => ({
  submitWorkflow: vi.fn(),
  resolveDownloadUrl: vi.fn(),
  isDefiniteNotFound: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', () => ({ submitWorkflow: h.submitWorkflow }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: h.resolveDownloadUrl,
  isDefiniteNotFound: h.isDefiniteNotFound,
}));

import {
  TrainingDataSourceUnreadable,
  uncountUnconfirmedResubmit,
  healStalledTrainingDataScans,
  trainingDataObjectUnchanged,
  requeuePendingTrainingDataScans,
  submitTrainingDataScan,
  submitTrainingDataScanSafe,
} from '~/server/services/training-data-scan.service';

const TARGET = { fileId: 56, modelVersionId: 7, url: 'https://bucket/data.zip' };
const ZIP_BYTES = 2048;

const ETAG = '"e1"';
const source = (init: { status?: number; length?: string | null; etag?: string | null } = {}) =>
  new Response(init.status && init.status >= 400 ? null : 'zipbytes', {
    status: init.status ?? 200,
    headers: {
      ...(init.length !== null && { 'content-length': init.length ?? String(ZIP_BYTES) }),
      ...(init.etag !== null && { etag: init.etag ?? ETAG }),
    },
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
  h.isDefiniteNotFound.mockReset().mockReturnValue(false);
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

    // Stamped first, so a submit that fails is still one the self-heal can find.
    expect(dbMock.dbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 56 },
      data: { scanRequestedAt: expect.any(Date) },
    });
    expect(dbMock.dbWrite.modelFile.update.mock.invocationCallOrder[0]).toBeLessThan(
      h.fetch.mock.invocationCallOrder[0]
    );

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
    const metadata = {
      fileId: 56,
      modelVersionId: 7,
      url: TARGET.url,
      etag: ETAG,
      size: ZIP_BYTES,
      scan: 'training-data-blob',
    };
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
    ['the zip has no ETag', () => h.fetch.mockResolvedValueOnce(source({ etag: null }))],
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

  it('gives a source lookup 30 seconds, then fails as transient', async () => {
    vi.useFakeTimers();
    try {
      h.resolveDownloadUrl.mockReturnValue(new Promise(() => undefined));
      const submit = submitTrainingDataScan(TARGET).catch((error: Error) => error);

      let settled = false;
      void submit.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      const error = await submit;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TrainingDataSourceUnreadable);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'no object at the url',
      () => {
        h.resolveDownloadUrl.mockRejectedValue(new Error('404'));
        h.isDefiniteNotFound.mockReturnValue(true);
      },
    ],
    ['no length', () => h.fetch.mockResolvedValueOnce(source({ length: null }))],
    ['no ETag', () => h.fetch.mockResolvedValueOnce(source({ etag: null }))],
  ])('calls a source with %s unreadable', async (_, arrange) => {
    arrange();
    await expect(submitTrainingDataScan(TARGET)).rejects.toBeInstanceOf(
      TrainingDataSourceUnreadable
    );
  });

  it.each([
    [
      'a lookup that is not a definite absence',
      () => h.resolveDownloadUrl.mockRejectedValue(new Error('503')),
    ],
    ['a refused read', () => h.fetch.mockResolvedValueOnce(source({ status: 503 }))],
  ])('calls %s transient', async (_, arrange) => {
    arrange();
    const error = await submitTrainingDataScan(TARGET).catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(TrainingDataSourceUnreadable);
  });

  it('submits nothing, and writes no verdict, without an orchestrator token outside production', async () => {
    setEnv({ ORCHESTRATOR_ACCESS_TOKEN: undefined });

    // Not a submit: the self-heal counts none toward giving up.
    expect(await submitTrainingDataScanSafe(TARGET, 'test')).toBe(false);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});

describe('trainingDataObjectUnchanged', () => {
  const SCANNED = { fileId: 56, url: TARGET.url, etag: ETAG, size: ZIP_BYTES };
  const answer = (status: number, headers: Record<string, string>) =>
    h.fetch.mockResolvedValue(new Response(status === 206 ? 'z' : null, { status, headers }));

  it('confirms the same ETag and length, reading one byte', async () => {
    answer(206, { etag: ETAG, 'content-range': `bytes 0-0/${ZIP_BYTES}` });

    expect(await trainingDataObjectUnchanged(SCANNED)).toBe(true);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('https://signed/data.zip');
    expect(init.headers).toEqual({ Range: 'bytes=0-0' });
  });

  it('confirms a full answer by its length', async () => {
    answer(200, { etag: ETAG, 'content-length': String(ZIP_BYTES) });
    expect(await trainingDataObjectUnchanged(SCANNED)).toBe(true);
  });

  it.each([
    [
      'another ETag',
      () => answer(206, { etag: '"e2"', 'content-range': `bytes 0-0/${ZIP_BYTES}` }),
    ],
    ['another length', () => answer(206, { etag: ETAG, 'content-range': 'bytes 0-0/4096' })],
    ['no length', () => answer(206, { etag: ETAG })],
    ['a refused read', () => answer(403, { etag: ETAG })],
    ['a failed request', () => h.fetch.mockRejectedValue(new Error('timeout'))],
    ['a failed url lookup', () => h.resolveDownloadUrl.mockRejectedValue(new Error('down'))],
  ])('does not confirm %s', async (_, arrange) => {
    arrange();
    expect(await trainingDataObjectUnchanged(SCANNED)).toBe(false);
  });

  it.each([
    ['no ETag', { ...SCANNED, etag: undefined }],
    ['no length', { ...SCANNED, size: undefined }],
  ])('does not confirm a scan that recorded %s, without asking', async (_, scanned) => {
    expect(await trainingDataObjectUnchanged(scanned)).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
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
    const [sql, ids, staleSeconds, neverSubmitted] = dbMock.dbWrite.$queryRaw.mock.calls[0];
    expect(ids).toEqual([1, 2]);
    // A claim older than the in-flight window is taken again, and so is a row never submitted.
    expect(sql.join('?')).toMatch(
      /AND "type" = 'Training Data'\s+AND \("scanRequestedAt" < now\(\) - \? \* interval '1 second'\s+OR \(\?::boolean AND "scanRequestedAt" IS NULL\)/
    );
    expect(staleSeconds).toBe(60 * 60);
    expect(neverSubmitted).toBe(true);
  });

  it('claims the page before it submits any of it', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await requeuePendingTrainingDataScans({ limit: 50, dryRun: false });

    expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      h.submitWorkflow.mock.invocationCallOrder[0]
    );
  });
});

describe('healStalledTrainingDataScans', () => {
  const stalled = { id: 3, url: 'https://bucket/3.zip', modelVersionId: 30 };

  beforeEach(() => {
    dbMock.dbWrite.modelFile.findMany.mockReset().mockResolvedValue([stalled]);
    dbMock.dbWrite.modelFile.updateMany.mockReset().mockResolvedValue({ count: 1 });
    dbMock.dbWrite.$queryRaw.mockReset().mockResolvedValue([{ id: 3 }]);
    redisMock.sysRedis.get.mockReset().mockResolvedValue(null);
    redisMock.sysRedis.incrBy.mockReset().mockResolvedValue(1);
  });

  it('never picks a zip that was never submitted, nor one on a removed model', async () => {
    await healStalledTrainingDataScans();

    const { where, take } = dbMock.dbWrite.modelFile.findMany.mock.calls[0][0];
    expect(take).toBe(6);
    expect(where).toMatchObject({
      type: 'Training Data',
      virusScanResult: 'Pending',
      modelVersion: {
        model: {
          deletedAt: null,
          tosViolation: false,
          status: { notIn: ['Deleted', 'UnpublishedViolation'] },
          OR: [{ mode: null }, { mode: { not: 'TakenDown' } }],
        },
      },
    });
    expect(where.scanRequestedAt.not).toBeNull();
    const waited = Date.now() - where.scanRequestedAt.lt.getTime();
    expect(waited).toBeGreaterThanOrEqual(60 * 60_000);
    expect(waited).toBeLessThan(60 * 60_000 + 5_000);
    // Nor claims one whose submission was reset between the read and the claim.
    const [, , , neverSubmitted] = dbMock.dbWrite.$queryRaw.mock.calls[0];
    expect(neverSubmitted).toBe(false);
  });

  it('resubmits a stalled zip and counts the accepted resubmit for that zip', async () => {
    redisMock.sysRedis.get.mockResolvedValue('2');

    const result = await healStalledTrainingDataScans();

    expect(h.submitWorkflow).toHaveBeenCalledTimes(1);
    const [key] = redisMock.sysRedis.incrBy.mock.calls[0];
    expect(redisMock.sysRedis.get).toHaveBeenCalledWith(key);
    expect(key).toMatch(/^system:training-data-scan:heal-attempts:3:[0-9a-f]{16}$/);
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ picked: 1, submitted: 1, gaveUp: [] });
  });

  it('marks the zip Error, and submits nothing, after three accepted resubmits', async () => {
    redisMock.sysRedis.get.mockResolvedValue('3');

    const result = await healStalledTrainingDataScans();

    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.updateMany).toHaveBeenCalledWith({
      where: { id: 3, url: stalled.url, type: 'Training Data', virusScanResult: 'Pending' },
      data: expect.objectContaining({ virusScanResult: 'Error' }),
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith({
      type: 'error',
      name: 'training-data-scan-gave-up',
      fileId: 3,
      reason: 'no verdict after 3 resubmits',
    });
    expect(result).toMatchObject({ gaveUp: [3], submitted: 0 });
  });

  it('gives up on no zip through an outage: a refused resubmit is not counted', async () => {
    h.submitWorkflow.mockRejectedValue(new Error('orchestrator down'));
    let count = 0;
    redisMock.sysRedis.get.mockImplementation(async () => String(count));
    redisMock.sysRedis.incrBy.mockImplementation(async () => ++count);

    for (let run = 0; run < 6; run++) await healStalledTrainingDataScans();

    expect(h.submitWorkflow).toHaveBeenCalledTimes(6);
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith({
      type: 'warning',
      name: 'training-data-scan-heal-submit-failed',
      count: 1,
    });
  });

  describe('a zip whose source answers', () => {
    const counts = new Map<string, number>();
    beforeEach(() => {
      counts.clear();
      redisMock.sysRedis.get.mockImplementation(async (key: string) =>
        counts.has(key) ? String(counts.get(key)) : null
      );
      redisMock.sysRedis.incrBy.mockImplementation(async (key: string) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key);
      });
      redisMock.sysRedis.decrBy.mockImplementation(async (key: string) => {
        counts.set(key, (counts.get(key) ?? 0) - 1);
        return counts.get(key);
      });
    });
    const gaveUp = () => dbMock.dbWrite.modelFile.updateMany.mock.calls.length > 0;
    beforeEach(() => loggingMock.logToAxiom.mockClear());

    it('a definite absence 24 times, is marked Error, logged once', async () => {
      h.resolveDownloadUrl.mockRejectedValue(new Error('404'));
      h.isDefiniteNotFound.mockReturnValue(true);

      for (let run = 0; run < 24; run++) await healStalledTrainingDataScans();
      expect(gaveUp()).toBe(false);
      await healStalledTrainingDataScans();

      expect(dbMock.dbWrite.modelFile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ virusScanResult: 'Error' }) })
      );
      const logged = loggingMock.logToAxiom.mock.calls.map(([event]) => event.name);
      expect(logged.filter((name) => name === 'training-data-scan-gave-up')).toHaveLength(1);
      expect(logged).not.toContain('training-data-scan-submit');
      expect(logged).not.toContain('training-data-scan-heal-submit-failed');
    });

    it('a transient failure 30 times, stays Pending', async () => {
      h.resolveDownloadUrl.mockRejectedValue(new Error('503'));

      for (let run = 0; run < 30; run++) await healStalledTrainingDataScans();

      expect(gaveUp()).toBe(false);
      expect(counts.size).toBe(0);
    });

    it('a clean scan whose object could not be confirmed, again and again, stays Pending', async () => {
      for (let run = 0; run < 5; run++) {
        await healStalledTrainingDataScans();
        expect(h.submitWorkflow.mock.calls[run][0].body.metadata.op).toBe('self-heal');
        // The verdict's re-check failed: the webhook takes the resubmit back.
        await uncountUnconfirmedResubmit({
          fileId: stalled.id,
          url: stalled.url,
          workflowId: `wf-${run}`,
        });
      }

      expect(gaveUp()).toBe(false);
      expect(h.submitWorkflow).toHaveBeenCalledTimes(5);
    });

    it('takes back no more than it counted', async () => {
      await uncountUnconfirmedResubmit({
        fileId: stalled.id,
        url: stalled.url,
        workflowId: 'wf-x',
      });
      for (let run = 0; run < 3; run++) await healStalledTrainingDataScans();
      await healStalledTrainingDataScans();

      expect(gaveUp()).toBe(true);
    });

    it('takes a workflow back once, however often its callback comes', async () => {
      for (let run = 0; run < 2; run++) await healStalledTrainingDataScans();
      for (let i = 0; i < 3; i++)
        await uncountUnconfirmedResubmit({
          fileId: stalled.id,
          url: stalled.url,
          workflowId: 'wf-0',
        });
      for (let run = 0; run < 2; run++) await healStalledTrainingDataScans();
      expect(gaveUp()).toBe(false);
      await healStalledTrainingDataScans();

      // 2 accepted, 1 taken back, 2 more accepted: the next claim reaches the cap of 3.
      expect(gaveUp()).toBe(true);
    });

    it('a clean scan that never confirms, 24 times, is marked Error', async () => {
      for (let run = 0; run < 24; run++) {
        await healStalledTrainingDataScans();
        await uncountUnconfirmedResubmit({
          fileId: stalled.id,
          url: stalled.url,
          workflowId: `wf-${run}`,
        });
      }
      expect(gaveUp()).toBe(false);
      await healStalledTrainingDataScans();

      expect(gaveUp()).toBe(true);
    });

    it('with no ETag 24 times, is marked Error', async () => {
      h.fetch.mockImplementation(async () => source({ etag: null }));

      for (let run = 0; run < 25; run++) await healStalledTrainingDataScans();

      expect(gaveUp()).toBe(true);
    });
  });

  it('counts, gives up on and submits nothing it did not claim', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    redisMock.sysRedis.get.mockResolvedValue('3');

    await healStalledTrainingDataScans();

    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('keeps one count per zip: the same zip again, a new zip afresh', async () => {
    dbMock.dbWrite.modelFile.findMany
      .mockResolvedValueOnce([stalled])
      .mockResolvedValueOnce([stalled])
      .mockResolvedValueOnce([{ ...stalled, url: 'https://bucket/3-new.zip' }]);

    for (let run = 0; run < 3; run++) await healStalledTrainingDataScans();

    const [[first], [again], [fresh]] = redisMock.sysRedis.incrBy.mock.calls;
    expect(again).toBe(first);
    expect(fresh).not.toBe(first);
  });

  it('neither resubmits nor gives up when the count cannot be read', async () => {
    redisMock.sysRedis.get.mockRejectedValue(new Error('redis down'));

    await healStalledTrainingDataScans();

    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
  });
});
