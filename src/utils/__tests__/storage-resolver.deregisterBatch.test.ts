import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Concrete internal URL + token so the configured branch is reachable. Any field
// we don't set falls back to the global env Proxy in src/__tests__/setup.ts.
// vi.hoisted so the object exists before the hoisted vi.mock factory runs.
const { envValues } = vi.hoisted(() => ({
  envValues: {
    STORAGE_RESOLVER_INTERNAL_URL: 'http://storage-resolver.internal',
    STORAGE_RESOLVER_INTERNAL_TOKEN: 'test-token',
  } as Record<string, unknown>,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy(envValues, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return undefined;
    },
  }),
}));

const { logToAxiom } = vi.hoisted(() => ({ logToAxiom: vi.fn(() => Promise.resolve()) }));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

import { deregisterFileLocationsBatch } from '~/utils/storage-resolver';

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe('deregisterFileLocationsBatch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    logToAxiom.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    // Restore the configured env for each test; individual tests may clear it.
    envValues.STORAGE_RESOLVER_INTERNAL_URL = 'http://storage-resolver.internal';
    envValues.STORAGE_RESOLVER_INTERNAL_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs modelVersionIds with the bearer token and returns the deleted count', async () => {
    fetchMock.mockResolvedValue(okResponse({ success: true, deleted: 4 }));

    const result = await deregisterFileLocationsBatch([1, 2, 3]);

    expect(result).toEqual({ deleted: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://storage-resolver.internal/deregister');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as any).headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ modelVersionIds: [1, 2, 3] });
    // Per-chunk unconditional abort so a hung resolver can't stall bulk cleanup.
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('is a no-op returning null (and warns) when storage-resolver is not configured', async () => {
    envValues.STORAGE_RESOLVER_INTERNAL_URL = undefined;
    envValues.STORAGE_RESOLVER_INTERNAL_TOKEN = undefined;

    const result = await deregisterFileLocationsBatch([1, 2, 3]);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-skipped', count: 3 })
    );
  });

  it('de-dupes + drops non-positive ids and makes no call when nothing survives', async () => {
    const result = await deregisterFileLocationsBatch([0, -1, -5]);

    expect(result).toEqual({ deleted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('de-dupes and drops non-positive ids before the request', async () => {
    fetchMock.mockResolvedValue(okResponse({ success: true, deleted: 2 }));

    const result = await deregisterFileLocationsBatch([1, 1, 2, 0, -3, 2]);

    expect(result).toEqual({ deleted: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      modelVersionIds: [1, 2],
    });
  });

  it('chunks at 500 ids/request and sums deleted across chunks', async () => {
    // 1200 unique ids → 3 chunks (500 + 500 + 200).
    const ids = Array.from({ length: 1200 }, (_, i) => i + 1);
    fetchMock
      .mockResolvedValueOnce(okResponse({ success: true, deleted: 500 }))
      .mockResolvedValueOnce(okResponse({ success: true, deleted: 500 }))
      .mockResolvedValueOnce(okResponse({ success: true, deleted: 200 }));

    const result = await deregisterFileLocationsBatch(ids);

    expect(result).toEqual({ deleted: 1200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const chunkSizes = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string).modelVersionIds.length
    );
    expect(chunkSizes).toEqual([500, 500, 200]);
  });

  it('is best-effort per chunk: a non-OK chunk is logged + skipped, others proceed', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1); // 2 chunks
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
        json: () => Promise.reject(new Error('not json')),
      })
      .mockResolvedValueOnce(okResponse({ success: true, deleted: 500 }));

    const result = await deregisterFileLocationsBatch(ids);

    // First chunk failed (counted 0), second succeeded — the loop never aborts.
    expect(result).toEqual({ deleted: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-failed', status: 500 })
    );
  });

  it('is best-effort per chunk: a thrown chunk is logged + skipped, others proceed', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1); // 2 chunks
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse({ success: true, deleted: 500 }));

    const result = await deregisterFileLocationsBatch(ids);

    expect(result).toEqual({ deleted: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-error' })
    );
  });

  it('never throws when the request times out against a hung resolver', async () => {
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    );

    await expect(deregisterFileLocationsBatch([1, 2, 3])).resolves.toEqual({ deleted: 0 });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-error' })
    );
  });
});
