import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * A Redis client that reaches the closed state (a connect() that failed during an outage) used to stay
 * memoized and closed for the life of the process: every caller got the same dead client and every
 * command threw "The client is closed". getRedis()/getSysRedis() now reopen it in place. The real
 * ensureClientOpen from @civitai/redis runs here; only the client factories are faked.
 */
type FakeClient = { isOpen: boolean; connect: Mock<() => Promise<void>> };

const h = vi.hoisted(() => ({
  cache: undefined as unknown as FakeClient,
  sys: undefined as unknown as FakeClient,
  createCacheRedis: vi.fn(),
  createSysRedis: vi.fn(),
}));

vi.mock('@civitai/redis', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCacheRedis: h.createCacheRedis,
  createSysRedis: h.createSysRedis,
}));

/** A client with node-redis 6's connect() semantics: it refuses to open twice. */
function fakeClient(isOpen: boolean): FakeClient {
  const c: FakeClient = {
    isOpen,
    connect: vi.fn(async () => {
      if (c.isOpen) throw new Error('already open');
      c.isOpen = true;
    }),
  };
  return c;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  process.env.REDIS_URL = 'redis://cache.test:6379';
  process.env.REDIS_SYS_URL = 'redis://sys.test:6379';
  h.createCacheRedis.mockReset().mockImplementation(() => h.cache);
  h.createSysRedis.mockReset().mockImplementation(() => h.sys);
});
afterEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.REDIS_SYS_URL;
});

describe.each([
  ['getRedis', 'cache', 'createCacheRedis'],
  ['getSysRedis', 'sys', 'createSysRedis'],
] as const)('%s', (getter, slot, factory) => {
  it('reopens a closed client once, however many concurrent callers find it closed', async () => {
    h[slot] = fakeClient(false);
    const mod = await import('../redis');
    const got = Array.from({ length: 20 }, () => mod[getter]());
    await settle();
    expect(new Set(got)).toEqual(new Set([h[slot]])); // one client, never a replacement per caller
    expect(h[factory]).toHaveBeenCalledTimes(1);
    expect(h[slot].connect).toHaveBeenCalledTimes(1);
    expect(h[slot].isOpen).toBe(true);
  });

  it('reopens it again if it closes later', async () => {
    h[slot] = fakeClient(true);
    const mod = await import('../redis');
    mod[getter]();
    await settle();
    expect(h[slot].connect).not.toHaveBeenCalled();
    h[slot].isOpen = false;
    mod[getter]();
    await settle();
    expect(h[slot].connect).toHaveBeenCalledTimes(1);
    expect(h[slot].isOpen).toBe(true);
    expect(h[factory]).toHaveBeenCalledTimes(1);
  });
});
