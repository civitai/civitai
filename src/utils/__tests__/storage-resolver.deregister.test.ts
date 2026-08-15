import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logToAxiom } = loggingMock;

import { deregisterFileLocations } from '~/utils/storage-resolver';

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe('deregisterFileLocations', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    logToAxiom.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    // Restore the configured env for each test; individual tests may clear it.
    setEnv({
      STORAGE_RESOLVER_INTERNAL_URL: 'http://storage-resolver.internal',
      STORAGE_RESOLVER_INTERNAL_TOKEN: 'test-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs modelVersionId with the bearer token and returns the deleted count', async () => {
    fetchMock.mockResolvedValue(okResponse({ success: true, deleted: 3, rows: [] }));

    const result = await deregisterFileLocations(67890);

    expect(result).toEqual({ deleted: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://storage-resolver.internal/deregister');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as any).headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ modelVersionId: 67890 });
    // Unconditional abort signal so a hung resolver can't block the delete forever.
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('is a no-op returning null (and warns) when storage-resolver is not configured', async () => {
    setEnv({
      STORAGE_RESOLVER_INTERNAL_URL: undefined,
      STORAGE_RESOLVER_INTERNAL_TOKEN: undefined,
    });

    const result = await deregisterFileLocations(1);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-skipped' })
    );
  });

  it('returns null (and logs) on a non-OK response — never throws', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
      json: () => Promise.reject(new Error('not json')),
    });

    await expect(deregisterFileLocations(2)).resolves.toBeNull();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-failed', status: 500 })
    );
  });

  it('returns null (and logs) when the resolver is unreachable — never throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(deregisterFileLocations(3)).resolves.toBeNull();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-error' })
    );
  });

  it('returns null (and logs) when the request times out against a hung resolver', async () => {
    // Simulate the AbortSignal.timeout firing: fetch rejects with an AbortError,
    // exactly as it would when a resolver accepts the socket but never replies.
    fetchMock.mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    );

    // Must resolve (never throw) so the awaited call in deleteVersionById can't
    // hang or fail the already-committed version delete.
    await expect(deregisterFileLocations(4)).resolves.toBeNull();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deregister-file-locations-error' })
    );
  });
});
