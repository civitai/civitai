import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { WEBHOOK_TOKEN: 't', CIVITAI_APP_URL: 'https://main' },
}));

const { syncSearchIndexBulk } = await import('../search-index');

const fetchMock = vi.fn();
const batch = { entityType: 'model', entityIds: [1], action: 'update' as const };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('syncSearchIndexBulk', () => {
  it.each([
    ['a refused call', () => fetchMock.mockResolvedValue(new Response('no', { status: 503 }))],
    ['a network error', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
  ])('throws on %s in strict mode', async (_, arm) => {
    arm();

    await expect(syncSearchIndexBulk(batch, { strict: true })).rejects.toThrow();
  });

  it('throws an error that does not carry the token', async () => {
    fetchMock.mockRejectedValue(new TypeError('Invalid URL: https://main/api?token=t'));

    const error = await syncSearchIndexBulk(batch, { strict: true }).catch((e: Error) => e);

    expect(String((error as Error).message)).not.toContain('token');
  });

  it('logs a network error without the request URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('Invalid URL: https://main/api?token=t'));

    await syncSearchIndexBulk(batch);

    const logged = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a)))
      .join(' ');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('token=');
  });

  it('only logs it by default', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 503 }));

    await expect(syncSearchIndexBulk(batch)).resolves.toBeUndefined();
  });

  it('resolves in strict mode when the call succeeds', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(syncSearchIndexBulk(batch, { strict: true })).resolves.toBeUndefined();
  });
});

describe('syncSearchIndexBulk without a token', () => {
  it('throws in strict mode, and only warns by default', async () => {
    vi.resetModules();
    vi.doMock('$env/dynamic/private', () => ({ env: { CIVITAI_APP_URL: 'https://main' } }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { syncSearchIndexBulk: sync } = await import('../search-index');

    await expect(sync(batch, { strict: true })).rejects.toThrow('WEBHOOK_TOKEN');
    await expect(sync(batch)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
