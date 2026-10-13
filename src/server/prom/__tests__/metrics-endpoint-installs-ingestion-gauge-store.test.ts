import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { setIngestionGaugeSharedStore } from '~/server/prom/client';

// The seam: without the page's side-effect import nothing installs the store, and every process
// silently goes back to running the ingestion queries itself.

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

describe('/api/metrics installs the shared image-ingestion gauge store', () => {
  it('CONTROL: nothing is installed before the page module loads', () => {
    expect(vi.mocked(setIngestionGaugeSharedStore)).not.toHaveBeenCalled();
  });

  it('loading the page module installs a store', async () => {
    await import('~/pages/api/metrics');

    expect(vi.mocked(setIngestionGaugeSharedStore)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setIngestionGaugeSharedStore).mock.calls[0][0]).toEqual({
      read: expect.any(Function),
      tryLock: expect.any(Function),
      write: expect.any(Function),
    });
  });
});
