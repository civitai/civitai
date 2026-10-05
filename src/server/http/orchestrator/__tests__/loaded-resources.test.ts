import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({ default: { get: mockGet } }));

import { getLoadedResourceAirs } from '~/server/http/orchestrator/loaded-resources';

describe('getLoadedResourceAirs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null while the orchestrator is restarting', async () => {
    mockGet.mockResolvedValue({ ok: false, status: 503, message: 'restarting' });
    await expect(getLoadedResourceAirs()).resolves.toBeNull();
  });

  it.each([500, 502, 404])('throws on any other failure (%i)', async (status) => {
    mockGet.mockResolvedValue({ ok: false, status, message: 'boom' });
    await expect(getLoadedResourceAirs()).rejects.toThrow(String(status));
  });

  it('throws when the body is not an array', async () => {
    mockGet.mockResolvedValue({ ok: true, status: 200, data: { items: [] } });
    await expect(getLoadedResourceAirs()).rejects.toThrow('expected an array');
  });

  it('asks the orchestrator to filter by source', async () => {
    mockGet.mockResolvedValue({ ok: true, status: 200, data: [] });
    await getLoadedResourceAirs({ source: 'civitai' });
    expect(mockGet).toHaveBeenCalledWith('/v1/manager/resources/loaded', {
      queryParams: { source: 'civitai' },
    });
  });

  it('returns the AIR strings', async () => {
    mockGet.mockResolvedValue({ ok: true, status: 200, data: ['urn:air:a', 7, 'urn:air:b'] });
    await expect(getLoadedResourceAirs()).resolves.toEqual(['urn:air:a', 'urn:air:b']);
  });
});
