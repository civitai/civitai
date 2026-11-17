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

  it('only logs it by default', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 503 }));

    await expect(syncSearchIndexBulk(batch)).resolves.toBeUndefined();
  });

  it('resolves in strict mode when the call succeeds', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(syncSearchIndexBulk(batch, { strict: true })).resolves.toBeUndefined();
  });
});
