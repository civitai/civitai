import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const h = vi.hoisted(() => ({ unblock: vi.fn(), trackImages: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  handleUnblockImages: h.unblock,
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    images = h.trackImages;
  },
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));

import handler from '~/pages/api/mod/restore-images';

const row = (id: number, blockedFor: string | null) => ({
  id,
  userId: 1,
  nsfwLevel: 1,
  blockedFor,
  tags: [],
});

const found = (rows: ReturnType<typeof row>[]) =>
  vi.mocked(dbMock.dbWrite.image.findMany).mockResolvedValue(rows as never);

const restore = async (imageIds: number[]) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
    { method: 'POST', body: { imageIds } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.json.mock.calls[0]?.[0];
};

beforeEach(() => {
  // The service answers with the images it restored; by default, all it was given.
  h.unblock
    .mockReset()
    .mockImplementation(async ({ ids }: { ids: number[] }) => ids.map((id) => ({ id })));
  h.trackImages.mockReset();
});

describe('/api/mod/restore-images', () => {
  it('skips a CSAM-blocked image and still restores the others in the batch', async () => {
    found([row(1, 'CSAM'), row(2, 'moderated')]);

    const body = await restore([1, 2]);

    expect(h.unblock.mock.calls.map(([arg]) => arg.ids)).toEqual([[2]]);
    expect(body).toEqual({ images: 1, skipped: [1] });
  });

  it('restores nothing when every image is CSAM-blocked', async () => {
    found([row(1, 'CSAM')]);

    const body = await restore([1]);

    expect(h.unblock).not.toHaveBeenCalled();
    expect(body).toEqual({ images: 0, skipped: [1] });
  });

  it('skips an image the replica has not yet seen CSAM-blocked', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([row(1, 'moderated')] as never);
    found([row(1, 'CSAM')]);

    const body = await restore([1]);

    expect(h.unblock).not.toHaveBeenCalled();
    expect(body).toEqual({ images: 0, skipped: [1] });
  });

  it('counts only the images the service restored', async () => {
    found([row(2, 'moderated'), row(3, 'moderated')]);
    h.unblock.mockResolvedValueOnce([{ id: 3 }]);

    const body = await restore([2, 3]);

    expect(body).toEqual({ images: 1, skipped: [] });
    expect(h.trackImages.mock.calls[0][0].map((e: { imageId: number }) => e.imageId)).toEqual([3]);
  });
});
