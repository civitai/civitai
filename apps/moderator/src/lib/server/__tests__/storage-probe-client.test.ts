import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The BUDGET the media-existence probe runs under, pinned as a value rather than as a behaviour.
 *
 * 🔴 Why this file exists. `getMediaProbeStorage` builds a second storage client purely to bound a
 * probe that sits on a moderator's click path: `timeoutMs: 5_000, retries: 0`. The guard's own suite
 * mocks `$lib/server/storage` wholesale, so it can prove the probe reaches the SEPARATE factory but
 * says nothing about what that factory asks for — deleting both lines left the whole `app:moderator`
 * project green. The defaults it would fall back to are `timeoutMs: 10_000, retries: 2`
 * (`packages/civitai-storage/src/client.ts`), i.e. three attempts plus backoff: roughly 31 s of a
 * moderator waiting for an answer that ALLOWS either way when it cannot be had.
 *
 * So the config object is asserted directly, at the seam where it is handed over.
 */
type ProbeConfig = {
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  retries?: number;
};

// Returns a FRESH object per call, so identity distinguishes the two clients without any test
// having to install an implementation (one installed here would leak to every later case).
const createStorageClient = vi.hoisted(() =>
  vi.fn((_config: ProbeConfig) => ({ tag: 'client' }) as Record<string, unknown>)
);
vi.mock('@civitai/storage', () => ({ createStorageClient }));

const ENDPOINT = 'https://storage.test.invalid';
const TOKEN = 'test-token';

/**
 * Both factories memoize their client in a module-scoped variable, so every case re-imports the
 * module to get an unbuilt one. Without this the second test in the file sees zero calls and passes
 * vacuously — the reassuring-zero shape.
 */
async function freshModule() {
  vi.resetModules();
  createStorageClient.mockClear();
  process.env.STORAGE_ENDPOINT = ENDPOINT;
  process.env.STORAGE_TOKEN = TOKEN;
  return import('../storage');
}

beforeEach(() => {
  createStorageClient.mockClear();
});

describe('getMediaProbeStorage — the probe budget', () => {
  it('asks for ONE attempt at 5 s, and nothing else', async () => {
    const { getMediaProbeStorage } = await freshModule();

    getMediaProbeStorage();

    // Pinned as a whole object, not by keyword. `toEqual` on the exact config fails if either bound
    // is deleted (the fallback is the client's own default, so the key is simply absent), if either
    // is retyped, or if an extra option is smuggled in.
    expect(createStorageClient).toHaveBeenCalledTimes(1);
    expect(createStorageClient).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 5_000,
      retries: 0,
    });
  });

  it('bounds it BELOW the library defaults it would otherwise inherit', async () => {
    /**
     * The mutation this kills that the pin above would also kill, but for the wrong reason: a value
     * that is present but useless (`retries: 2`, `timeoutMs: 10_000`) is not a bound at all. Written
     * against the LIBRARY's defaults rather than against the literals above, so it keeps meaning
     * something if someone re-tunes the pin.
     */
    const { getMediaProbeStorage } = await freshModule();

    getMediaProbeStorage();

    const config = createStorageClient.mock.calls[0][0];
    expect(config.timeoutMs).toBeLessThan(10_000);
    expect(config.retries).toBeLessThan(2);
    // One attempt, so the worst case is the timeout itself rather than a multiple of it.
    expect(config.retries).toBe(0);
  });

  it('memoizes, so a click path never rebuilds the client', async () => {
    const { getMediaProbeStorage } = await freshModule();

    const first = getMediaProbeStorage();
    const second = getMediaProbeStorage();

    expect(second).toBe(first);
    expect(createStorageClient).toHaveBeenCalledTimes(1);
  });
});

describe('getStorage — the general-purpose client is deliberately NOT bounded', () => {
  it('takes the library defaults, so the two clients are not interchangeable', async () => {
    /**
     * The other half of the relationship, and the reason the probe needs its own client at all.
     * Asserting only the probe's config would stay green if someone "simplified" by bounding
     * `getStorage` too and pointing the probe at it — which would put a 5 s / no-retry budget on the
     * WRITE operations this client serves, where giving up early loses work.
     */
    const { getStorage } = await freshModule();

    getStorage();

    expect(createStorageClient).toHaveBeenCalledTimes(1);
    expect(createStorageClient).toHaveBeenCalledWith({ endpoint: ENDPOINT, token: TOKEN });
  });

  it('is a DIFFERENT client instance from the probe one', async () => {
    // No `mockImplementation` here on purpose: the hoisted factory already returns a fresh object
    // per call, and installing one would LEAK to every later case (`clearAllMocks`/`mockClear`
    // clear calls, not implementations) — the exact harness defect this PR fixed elsewhere.
    const { getStorage, getMediaProbeStorage } = await freshModule();

    expect(getStorage()).not.toBe(getMediaProbeStorage());
    expect(createStorageClient).toHaveBeenCalledTimes(2);
  });
});
