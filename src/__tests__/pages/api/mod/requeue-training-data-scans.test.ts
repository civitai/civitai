import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ requeue: vi.fn() }));

vi.mock('~/server/services/training-data-scan.service', () => ({
  requeuePendingTrainingDataScans: h.requeue,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: unknown) => handler,
}));

import handler from '~/pages/api/mod/requeue-training-data-scans';

const call = (method: string, query: Record<string, string> = {}) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
    { method, query } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
};

beforeEach(() => {
  h.requeue.mockReset().mockResolvedValue({});
});

describe('/api/mod/requeue-training-data-scans', () => {
  it('only counts on a GET', async () => {
    await call('GET');
    expect(h.requeue).toHaveBeenCalledWith({ limit: 10, afterId: undefined, dryRun: true });
  });

  it('submits the page on a POST', async () => {
    await call('POST', { limit: '20', afterId: '99' });
    expect(h.requeue).toHaveBeenCalledWith({ limit: 20, afterId: 99, dryRun: false });
  });

  it('refuses a page over 25', async () => {
    await expect(call('POST', { limit: '26' })).rejects.toThrow();
    expect(h.requeue).not.toHaveBeenCalled();
  });
});
