import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RateLimitBucket from '~/server/utils/rate-limit-bucket';
import { isFailClosedRateLimitScope } from '~/server/utils/rate-limit-bucket';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as BlobRatings from '~/server/services/orchestrator/blobRatings';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';

const blob = vi.hoisted(() => ({ readBlobState: vi.fn() }));
const orch = vi.hoisted(() => ({ submitSearchUploadScan: vi.fn() }));
const wf = vi.hoisted(() => ({ getWorkflow: vi.fn() }));
const h = vi.hoisted(() => ({ claim: vi.fn() }));
vi.mock('~/server/services/orchestrator/blobRatings', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobRatings>()),
  ...blob,
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  ...orch,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  ...wf,
}));
vi.mock('~/server/utils/rate-limit-bucket', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitBucket>()),
  claimRateLimitAttempt: h.claim,
}));

import {
  claimSearchUploadSlot,
  getSearchUploadStatus,
  prepareSearchUpload,
  resolveSearchUploadAnchor,
  SEARCH_UPLOAD_GLOBAL_DAILY_CAP,
  SEARCH_UPLOAD_REFUSED_MESSAGE,
  SEARCH_UPLOAD_SCAN_TIMEOUT_MS,
  SEARCH_UPLOAD_TTL_MS,
} from '~/server/services/image-search-upload.service';

/** An in-memory stand-in for the cache the upload record lives in. */
const store = new Map<string, unknown>();
beforeEach(() => {
  store.clear();
  redisMock.redis.packed.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
  redisMock.redis.exists.mockImplementation(async (key: string) => (store.has(key) ? 1 : 0));
  redisMock.redis.del.mockImplementation(async (key: string) => (store.delete(key) ? 1 : 0));
});

describe('the global daily upload cap', () => {
  const req = { headers: {} } as never;
  beforeEach(() => {
    h.claim.mockReset().mockResolvedValue(async () => undefined);
  });

  it("draws every viewer from one daily bucket of the cap's size", async () => {
    await claimSearchUploadSlot(req);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        keyName: 'imageSearchUpload:global',
        scope: 'imageSearchUpload.prepare',
        user: { id: 0 },
        rules: [expect.objectContaining({ limit: SEARCH_UPLOAD_GLOBAL_DAILY_CAP, period: 86400 })],
      })
    );
  });

  it('counts the upload against the bucket once admitted', async () => {
    const record = vi.fn(async () => undefined);
    h.claim.mockResolvedValue(record);
    await claimSearchUploadSlot(req);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('refuses when the bucket is full', async () => {
    h.claim.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(claimSearchUploadSlot(req)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('is in a fail-closed scope, so an unreadable store refuses', () => {
    expect(isFailClosedRateLimitScope('imageSearchUpload.prepare')).toBe(true);
  });
});

const BLOB_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/blob-1';
const scanned = (over: Record<string, unknown> = {}) => ({
  status: 'succeeded',
  steps: [
    {
      $type: 'imageScanning',
      output: {
        nsfwLevel: 'pg',
        blockedReason: null,
        jointAgeClassification: { ran: true, detections: [] },
        ...over,
      },
    },
  ],
});

describe('preparing a search upload', () => {
  const prepare = (url = BLOB_URL, userId = 5) =>
    prepareSearchUpload({ userId, url, req: {} as never });

  beforeEach(() => {
    h.claim.mockReset().mockResolvedValue(async () => undefined);
    orch.submitSearchUploadScan.mockReset().mockResolvedValue('wf-1');
  });

  it('refuses a url that is not an uploaded blob before taking a slot', async () => {
    await expect(prepare('https://evil.test/v2/consumer/blobs/x')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(orch.submitSearchUploadScan).not.toHaveBeenCalled();
  });

  it('scans the blob and keeps only ids, writing no row', async () => {
    const { uploadId } = await prepare();
    expect(orch.submitSearchUploadScan).toHaveBeenCalledWith({ blobUrl: BLOB_URL });
    const record = [...store.entries()].find(([key]) => key.endsWith(`:${uploadId}`))?.[1];
    expect(record).toMatchObject({ userId: 5, blobId: 'blob-1', workflowId: 'wf-1' });
    expect(JSON.stringify([...store.values()])).not.toContain('https://');
    // Expiring with the upload.
    expect(redisMock.redis.packed.set).toHaveBeenCalledWith(
      expect.stringContaining(uploadId),
      expect.anything(),
      { EX: SEARCH_UPLOAD_TTL_MS / 1000 }
    );
  });

  it("reuses the viewer's upload of the same blob without a slot or a scan", async () => {
    const first = await prepare();
    h.claim.mockClear();
    orch.submitSearchUploadScan.mockClear();
    await expect(prepare()).resolves.toEqual(first);
    expect(h.claim).not.toHaveBeenCalled();
    expect(orch.submitSearchUploadScan).not.toHaveBeenCalled();
  });

  it('refuses while the viewer has an upload still being scanned, without taking a slot', async () => {
    await prepare();
    h.claim.mockClear();
    await expect(
      prepare('https://orchestration.civitai.com/v2/consumer/blobs/blob-2')
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('takes a slot before scanning, and scans nothing once the cap is reached', async () => {
    h.claim.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(orch.submitSearchUploadScan).not.toHaveBeenCalled();
  });

  it('fails, keeping nothing, when the scan cannot be submitted', async () => {
    orch.submitSearchUploadScan.mockResolvedValue(undefined);
    await expect(prepare()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(store.size).toBe(0);
  });
});

describe('search upload status and search anchor', () => {
  const MIN = '0.5';
  let uploadId: string;
  const status = (isModerator = false, userId = 5) =>
    getSearchUploadStatus({ userId, uploadId, isModerator });
  const anchor = (isModerator = false, url = BLOB_URL) =>
    resolveSearchUploadAnchor({ userId: 5, uploadId, url, isModerator });

  beforeEach(async () => {
    vi.useRealTimers();
    setEnv({ SEARCH_UPLOAD_FACE_ANIME_MIN: MIN });
    h.claim.mockReset().mockResolvedValue(async () => undefined);
    orch.submitSearchUploadScan.mockReset().mockResolvedValue('wf-1');
    wf.getWorkflow.mockReset().mockResolvedValue(scanned());
    blob.readBlobState.mockReset().mockResolvedValue({
      verdict: 'rated',
      nsfwLevel: 'pg',
      blockedReason: null,
      location: null,
    });
    ({ uploadId } = await prepareSearchUpload({ userId: 5, url: BLOB_URL, req: {} as never }));
  });

  it("gives a passed upload's level and its own blob url, read from its workflow", async () => {
    await expect(anchor()).resolves.toEqual({ nsfwLevel: 1, imageUrl: BLOB_URL });
    expect(wf.getWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ path: { workflowId: 'wf-1' } })
    );
    expect(blob.readBlobState).toHaveBeenCalledWith('blob-1');
  });

  it('reads the workflow once it has ended, not again on later pages', async () => {
    await anchor();
    await anchor();
    expect(wf.getWorkflow).toHaveBeenCalledTimes(1);
  });

  it('is not found for another viewer, or once the upload has expired', async () => {
    await expect(status(false, 6)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    vi.useFakeTimers({ now: Date.now() + SEARCH_UPLOAD_TTL_MS + 1000 });
    await expect(status()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an anchor whose url is not the uploaded blob', async () => {
    await expect(
      anchor(false, 'https://orchestration.civitai.com/v2/consumer/blobs/blob-2')
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('waits while the scan is running', async () => {
    wf.getWorkflow.mockResolvedValue({ status: 'processing', steps: [] });
    await expect(status()).resolves.toEqual({ status: 'pending' });
    await expect(anchor()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a scan that has not answered by the timeout, for a moderator too', async () => {
    wf.getWorkflow.mockResolvedValue({ status: 'processing', steps: [] });
    vi.useFakeTimers({ now: Date.now() + SEARCH_UPLOAD_SCAN_TIMEOUT_MS + 1000 });
    await expect(status(true)).resolves.toEqual({
      status: 'refused',
      message: SEARCH_UPLOAD_REFUSED_MESSAGE,
    });
  });

  it.each(['failed', 'expired', 'canceled'])(
    'refuses a scan that %s, for a moderator too',
    async (wfStatus) => {
      wf.getWorkflow.mockResolvedValue({ status: wfStatus, steps: [] });
      await expect(anchor(true)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: SEARCH_UPLOAD_REFUSED_MESSAGE,
      });
    }
  );

  it('refuses a moderator a minor flag, with only the generic message', async () => {
    wf.getWorkflow.mockResolvedValue(
      scanned({ jointAgeClassification: { ran: true, minorDetected: true, detections: [] } })
    );
    await expect(status(true)).resolves.toEqual({
      status: 'refused',
      message: SEARCH_UPLOAD_REFUSED_MESSAGE,
    });
  });

  it('refuses a non-moderator a photo, and lets a moderator search', async () => {
    wf.getWorkflow.mockResolvedValue(
      scanned({
        jointAgeClassification: { ran: true, detections: [{ animeProbability: 0.1 }] },
      })
    );
    await expect(anchor()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(anchor(true)).resolves.toMatchObject({ nsfwLevel: 1 });
  });

  it('logs a refusal with ids and the reason, never the url', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    wf.getWorkflow.mockResolvedValue({ status: 'failed', steps: [] });
    await status();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'search-upload-refused',
        userId: 5,
        workflowId: 'wf-1',
        reason: 'scan-failed',
      })
    );
    expect(JSON.stringify(vi.mocked(logToAxiom).mock.calls)).not.toContain('blobs/');
  });

  it('frees the viewer for a new upload once the scan has ended', async () => {
    await status();
    await expect(
      prepareSearchUpload({
        userId: 5,
        url: 'https://orchestration.civitai.com/v2/consumer/blobs/blob-2',
        req: {} as never,
      })
    ).resolves.toMatchObject({ uploadId: expect.any(String) });
  });
});
