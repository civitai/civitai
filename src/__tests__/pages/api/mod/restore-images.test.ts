import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const h = vi.hoisted(() => ({ unblock: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  handleUnblockImages: h.unblock,
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    images = vi.fn();
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
  vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue(rows as never);

const restore = async (imageIds: number[]) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
    { method: 'POST', body: { imageIds } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res.json.mock.calls[0]?.[0];
};

beforeEach(() => {
  h.unblock.mockReset().mockResolvedValue(undefined);
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
});
