import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { registerFileLocation } from '~/utils/storage-resolver';

/**
 * Without a signal this inherits undici's 300s default. Every caller awaits it, so one hung
 * registration holds the caller's job lock far past its own budget — which is what lets a second
 * run start on work the first still owns.
 */
const params = {
  fileId: 1,
  modelVersionId: 42,
  modelId: 5,
  backend: 'backblaze',
  path: 'model/7/x.safetensors',
  sizeKb: 2,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  setEnv({
    STORAGE_RESOLVER_INTERNAL_URL: 'https://resolver.example',
    STORAGE_RESOLVER_INTERNAL_TOKEN: 'token',
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('registerFileLocation', () => {
  it('gives up rather than hanging its caller', async () => {
    await registerFileLocation(params);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Generous for an internal write, and far inside any caller's lock.
    expect(init.signal.aborted).toBe(false);
  });

  it('does not call out at all when the resolver is not configured', async () => {
    setEnv({
      STORAGE_RESOLVER_INTERNAL_URL: undefined,
      STORAGE_RESOLVER_INTERNAL_TOKEN: undefined,
    });

    await registerFileLocation(params);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
