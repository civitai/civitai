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

// Keep the real fetch-timeout out of the picture (no dangling timers in tests).
vi.mock('~/server/utils/fetch-timeout', () => ({ fetchTimeoutSignal: () => undefined }));

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
    envValues.STORAGE_RESOLVER_INTERNAL_URL = 'http://storage-resolver.internal';
    envValues.STORAGE_RESOLVER_INTERNAL_TOKEN = 'test-token';
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
  });

  it('is a no-op returning null (and warns) when storage-resolver is not configured', async () => {
    envValues.STORAGE_RESOLVER_INTERNAL_URL = undefined;
    envValues.STORAGE_RESOLVER_INTERNAL_TOKEN = undefined;

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
});
