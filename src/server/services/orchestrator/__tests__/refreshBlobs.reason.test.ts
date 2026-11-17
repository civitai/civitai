import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRefreshBlob } = vi.hoisted(() => ({ mockRefreshBlob: vi.fn() }));

vi.mock('@civitai/orchestration-client', () => ({ refreshBlob: mockRefreshBlob }));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: () => ({}),
}));

import { refreshBlobsService } from '~/server/services/orchestrator/refreshBlobs';

const answer = (data: Record<string, unknown> | undefined, status = 200) => ({
  data,
  response: { status },
});
const refresh = async () =>
  (await refreshBlobsService({ token: 't', blobIds: ['B1.safetensors'] }))[0];

beforeEach(() => mockRefreshBlob.mockReset());

describe('refreshBlobsService: why a blob is gone', () => {
  it.each([
    ['a blocked blob', answer({ blockedReason: 'nsfw' }), 'blocked'],
    ['an unavailable blob', answer({ available: false }), 'blocked'],
    ['a blob the orchestrator cannot find', answer(undefined, 404), 'missing'],
  ])('names %s', async (_, response, reason) => {
    mockRefreshBlob.mockResolvedValue(response);

    expect(await refresh()).toEqual({ blobId: 'B1.safetensors', status: 'gone', reason });
  });

  it('a blocked answer on a 404 is still blocked', async () => {
    mockRefreshBlob.mockResolvedValue(answer({ blockedReason: 'nsfw' }, 404));

    expect(await refresh()).toMatchObject({ status: 'gone', reason: 'blocked' });
  });

  it('a fresh url is refreshed', async () => {
    mockRefreshBlob.mockResolvedValue(answer({ url: 'https://o/v2/consumer/blobs/B1?sig=f' }));

    expect(await refresh()).toEqual({
      blobId: 'B1.safetensors',
      status: 'refreshed',
      url: 'https://o/v2/consumer/blobs/B1?sig=f',
    });
  });
});
