import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RateLimitBucket from '~/server/utils/rate-limit-bucket';
import { isFailClosedRateLimitScope } from '~/server/utils/rate-limit-bucket';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
  claimSearchUploadUserDay,
  withSearchUploadSearch,
  getSearchUploadStatus,
  prepareSearchUpload,
  resolveSearchUploadAnchor,
  SEARCH_UPLOAD_GLOBAL_DAILY_CAP,
  SEARCH_UPLOAD_REFUSED_MESSAGE,
  SEARCH_UPLOAD_SCAN_TIMEOUT_MS,
  SEARCH_UPLOAD_SOURCE_MESSAGE,
  SEARCH_UPLOAD_TTL_MS,
  SEARCH_UPLOAD_USER_DAILY_LIMITS,
} from '~/server/services/image-search-upload.service';

/** An in-memory stand-in for the cache the upload record lives in. */
const store = new Map<string, unknown>();
beforeEach(() => {
  store.clear();
  redisMock.redis.packed.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
  dbMock.dbRead.image.findUnique.mockResolvedValue({ id: 9 } as never);
  redisMock.redis.exists.mockImplementation(async (key: string) => (store.has(key) ? 1 : 0));
  redisMock.redis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.redis.set.mockImplementation(
    async (key: string, value: unknown, opts?: { NX?: boolean }) => {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }
  );
  redisMock.redis.del.mockImplementation(async (key: string) => (store.delete(key) ? 1 : 0));
  redisMock.redis.eval.mockImplementation(
    async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) =>
      store.get(keys[0]) === args[0] && store.delete(keys[0]) ? 1 : 0
  );
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
const SOURCE = { kind: 'image' as const, id: 9 };
const scanned = (over: Record<string, unknown> = {}) => ({
  status: 'succeeded',
  steps: [
    {
      $type: 'imageScanning',
      completedAt: new Date().toISOString(),
      output: {
        nsfwLevel: 'pg',
        blockedReason: null,
        jointAgeClassification: { ran: true, detections: [] },
        ...over,
      },
    },
  ],
});

describe("the viewer's daily limit", () => {
  const req = { headers: {} } as never;
  beforeEach(() => {
    h.claim.mockReset().mockResolvedValue(async () => undefined);
  });

  it('counts a moderator by id only, so the moderator exemption does not apply', async () => {
    const record = vi.fn(async () => undefined);
    h.claim.mockResolvedValue(record);
    await claimSearchUploadUserDay({ userId: 5, action: 'search', req });
    expect(record).toHaveBeenCalledTimes(1);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 5 },
        scope: 'imageSearchUpload.search',
        rules: [
          expect.objectContaining({ limit: SEARCH_UPLOAD_USER_DAILY_LIMITS.search, period: 86400 }),
        ],
      })
    );
    expect(isFailClosedRateLimitScope('imageSearchUpload.search')).toBe(true);
  });
});

describe("one of the viewer's upload searches at a time", () => {
  it('refuses a second while the first runs, and frees the viewer after', async () => {
    let release!: () => void;
    const first = withSearchUploadSearch(5, () => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    await expect(withSearchUploadSearch(5, async () => 'second')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(withSearchUploadSearch(6, async () => 'other viewer')).resolves.toBe(
      'other viewer'
    );
    await expect(withSearchUploadSearch(5, async () => 'third')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    release();
    await first;
    await expect(withSearchUploadSearch(5, async () => 'after')).resolves.toBe('after');
  });

  const holdKey = () => [...store.keys()].find((k) => k.includes('search-upload-searching'));

  it('takes the hold with an expiry, so a crashed search cannot lock the viewer out', async () => {
    await withSearchUploadSearch(5, async () => undefined);
    expect(redisMock.redis.set).toHaveBeenCalledWith(
      expect.stringContaining('search-upload-searching'),
      expect.any(String),
      { NX: true, EX: 60 }
    );
  });

  it("does not free a newer search's hold when the first outlives its own", async () => {
    let release!: () => void;
    const first = withSearchUploadSearch(5, () => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    const key = holdKey()!;
    store.set(key, 'newer-request-token');
    release();
    await first;
    expect(store.get(key)).toBe('newer-request-token');
  });

  it('frees the viewer when the search throws, and the error still surfaces', async () => {
    await expect(
      withSearchUploadSearch(5, async () => {
        throw new Error('search failed');
      })
    ).rejects.toThrow('search failed');
    expect(holdKey()).toBeUndefined();
  });

  it('refuses without searching when the hold cannot be taken', async () => {
    const run = vi.fn(async () => 'ran');
    redisMock.redis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(withSearchUploadSearch(5, run)).rejects.toThrow();
    redisMock.redis.set.mockResolvedValueOnce(undefined as never);
    await expect(withSearchUploadSearch(5, run)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the search's result and refusal when the release fails", async () => {
    redisMock.redis.eval.mockRejectedValue(new Error('redis down'));
    await expect(withSearchUploadSearch(5, async () => 'result')).resolves.toBe('result');
    store.clear();
    const refusal = new TRPCError({ code: 'FORBIDDEN', message: 'no' });
    await expect(
      withSearchUploadSearch(5, async () => {
        throw refusal;
      })
    ).rejects.toBe(refusal);
  });
});

describe('preparing a search upload', () => {
  const prepare = (url = BLOB_URL, userId = 5) =>
    prepareSearchUpload({ userId, url, source: SOURCE, req: {} as never });

  beforeEach(() => {
    h.claim.mockReset().mockResolvedValue(async () => undefined);
    orch.submitSearchUploadScan.mockReset().mockResolvedValue('wf-1');
  });

  it('refuses an upload with no source, or a source that does not exist, before anything else', async () => {
    await expect(
      prepareSearchUpload({ userId: 5, url: BLOB_URL, source: undefined, req: {} as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: SEARCH_UPLOAD_SOURCE_MESSAGE });
    dbMock.dbRead.image.findUnique.mockResolvedValue(null);
    await expect(prepare()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9 } })
    );
    expect(h.claim).not.toHaveBeenCalled();
    expect(orch.submitSearchUploadScan).not.toHaveBeenCalled();
  });

  it('records the source on the upload; a case is taken by its reference', async () => {
    const { uploadId } = await prepareSearchUpload({
      userId: 5,
      url: BLOB_URL,
      source: { kind: 'case', id: 'TD-26-ABC123' },
      req: {} as never,
    });
    const record = [...store.entries()].find(([key]) => key.endsWith(`:${uploadId}`))?.[1];
    expect(record).toMatchObject({ source: { kind: 'case', id: 'TD-26-ABC123' } });
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
    expect((record as { urlHash: string }).urlHash).toMatch(/^[0-9a-f]{64}$/);
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

  it('reuses an upload only for the same source', async () => {
    const first = await prepare();
    store.forEach((_v, k) => k.includes('search-upload-pending') && store.delete(k));
    dbMock.dbRead.post.findUnique.mockResolvedValue({ id: 3 } as never);
    const other = await prepareSearchUpload({
      userId: 5,
      url: BLOB_URL,
      source: { kind: 'post', id: 3 },
      req: {} as never,
    });
    expect(other.uploadId).not.toBe(first.uploadId);
  });

  it('refuses while the viewer has an upload still being scanned, without taking a slot', async () => {
    await prepare();
    h.claim.mockClear();
    await expect(
      prepare('https://orchestration.civitai.com/v2/consumer/blobs/blob-2')
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("counts the upload against the viewer's daily uploads before the site-wide cap", async () => {
    await prepare();
    expect(h.claim.mock.calls.map(([a]) => a.keyName)).toEqual([
      'imageSearchUpload:user-prepare',
      'imageSearchUpload:global',
    ]);
  });

  it('takes a slot before scanning, and scans nothing once the cap is reached', async () => {
    h.claim.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(orch.submitSearchUploadScan).not.toHaveBeenCalled();
  });

  it('fails, keeping nothing and leaving the viewer free, when the scan cannot be submitted', async () => {
    orch.submitSearchUploadScan.mockResolvedValue(undefined);
    await expect(prepare()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(store.size).toBe(0);
  });

  it('leaves the viewer free when the cap refuses', async () => {
    h.claim.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(prepare()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(store.size).toBe(0);
  });

  it('lets only one of two uploads at once through', async () => {
    const results = await Promise.allSettled([
      prepare(),
      prepare('https://orchestration.civitai.com/v2/consumer/blobs/blob-2'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(orch.submitSearchUploadScan).toHaveBeenCalledTimes(1);
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
    ({ uploadId } = await prepareSearchUpload({
      userId: 5,
      url: BLOB_URL,
      source: SOURCE,
      req: {} as never,
    }));
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

  it('refuses an anchor whose url is not the uploaded blob, or not the url that was scanned', async () => {
    await expect(
      anchor(false, 'https://orchestration.civitai.com/v2/consumer/blobs/blob-2')
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(anchor(false, `${BLOB_URL}?v=2`)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a scan that finished after the timeout, read for the first time later', async () => {
    const late = scanned();
    (late.steps[0] as { completedAt: string }).completedAt = new Date(
      Date.now() + SEARCH_UPLOAD_SCAN_TIMEOUT_MS + 60_000
    ).toISOString();
    wf.getWorkflow.mockResolvedValue(late);
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a scan with no completion time', async () => {
    const unknown = scanned();
    delete (unknown.steps[0] as { completedAt?: string }).completedAt;
    wf.getWorkflow.mockResolvedValue(unknown);
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps a refusal for a blob verdict that never came, even once it does', async () => {
    blob.readBlobState.mockResolvedValue({ verdict: 'pending' });
    await expect(status(true)).resolves.toEqual({ status: 'pending' });
    vi.useFakeTimers({ now: Date.now() + SEARCH_UPLOAD_SCAN_TIMEOUT_MS + 1000 });
    await expect(status(true)).resolves.toMatchObject({ status: 'refused' });
    blob.readBlobState.mockResolvedValue({
      verdict: 'rated',
      nsfwLevel: 'pg',
      blockedReason: null,
      location: null,
    });
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a blob verdict that first came in after the timeout, without the kept refusal', async () => {
    blob.readBlobState.mockResolvedValue({ verdict: 'pending' });
    await status(true);
    vi.useFakeTimers({ now: Date.now() + SEARCH_UPLOAD_SCAN_TIMEOUT_MS + 1000 });
    blob.readBlobState.mockResolvedValue({
      verdict: 'rated',
      nsfwLevel: 'pg',
      blockedReason: null,
      location: null,
    });
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    store.forEach((_v, k) => k.endsWith(':refused') && store.delete(k));
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an upload whose refusal was kept, whatever the scan now says', async () => {
    store.set(`packed:caches:search-upload:${uploadId}:refused`, 'blocked');
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(wf.getWorkflow).not.toHaveBeenCalled();
  });

  it('keeps a timed-out refusal even when the scan later succeeds', async () => {
    // Finished inside the window, so only the kept refusal can refuse it below.
    const inTime = scanned();
    wf.getWorkflow.mockResolvedValue({ status: 'processing', steps: [] });
    vi.useFakeTimers({ now: Date.now() + SEARCH_UPLOAD_SCAN_TIMEOUT_MS + 1000 });
    await expect(status(true)).resolves.toMatchObject({ status: 'refused' });
    // The refusal is kept under its own key, which every later read checks first.
    const kept = [...store.entries()].find(([k]) => k.endsWith(':refused'));
    expect(kept?.[1]).toBe('timed-out');
    wf.getWorkflow.mockResolvedValue(inTime);
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps a passed blob verdict, so a later failed read does not stop the search', async () => {
    await anchor();
    blob.readBlobState.mockResolvedValue({ verdict: 'pending' });
    await expect(anchor()).resolves.toMatchObject({ nsfwLevel: 1 });
    expect(blob.readBlobState).toHaveBeenCalledTimes(1);
  });

  it("does not free a newer upload's busy hold when an older scan ends", async () => {
    const busyKey = [...store.keys()].find((k) => k.includes('search-upload-pending'))!;
    store.set(busyKey, 'a-newer-upload');
    await status();
    expect(store.get(busyKey)).toBe('a-newer-upload');
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

  it('refuses a blob the orchestrator refused, for a moderator too', async () => {
    blob.readBlobState.mockResolvedValue({
      verdict: 'rated',
      nsfwLevel: 'pg',
      blockedReason: 'refused',
      location: null,
    });
    await expect(anchor(true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

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
        payload: { sourceKind: 'image', sourceId: '9' },
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
        source: SOURCE,
        req: {} as never,
      })
    ).resolves.toMatchObject({ uploadId: expect.any(String) });
  });
});
