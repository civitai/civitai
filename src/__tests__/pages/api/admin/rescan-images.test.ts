import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

const { mockIngestImageById } = vi.hoisted(() => ({ mockIngestImageById: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  ingestImageById: mockIngestImageById,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/admin/rescan-images';

const runRequest = async (imageIds: string) => {
  const req = { method: 'GET', query: { imageIds } } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  await handler(req, res);
  return res;
};

beforeEach(() => {
  mockIngestImageById.mockReset();
});

describe('/api/admin/rescan-images', () => {
  it('reports each id on its own when one is missing, instead of failing the batch', async () => {
    mockIngestImageById.mockImplementation(async ({ id }: { id: number }) => {
      if (id === 2) throw new TRPCError({ code: 'NOT_FOUND' });
      if (id === 4) throw new Error('db timeout');
      return id !== 5;
    });

    const res = await runRequest('1,2,3,4,5');

    // Every id is attempted, including those after the missing one.
    expect(mockIngestImageById).toHaveBeenCalledTimes(5);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      imageIds: [1, 2, 3, 4, 5],
      submitted: [1, 3],
      notFound: [2],
      failed: [
        { id: 4, reason: 'db timeout' },
        { id: 5, reason: 'submit-rejected' },
      ],
    });
  });

  it('truncates a long failure reason', async () => {
    mockIngestImageById.mockRejectedValue(new Error('x'.repeat(1000)));

    const res = await runRequest('7');

    const body = res.json.mock.calls[0][0] as { failed: { reason: string }[] };
    expect(body.failed[0].reason.length).toBeLessThanOrEqual(200);
  });
});
