import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { bustImageModRulesCache } = vi.hoisted(() => ({
  bustImageModRulesCache: vi.fn(async () => undefined),
}));

// The wrapper's token check has its own suite; this one is about which rules the handler may touch.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
  handleEndpointError: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ bustImageModRulesCache }));

const { default: handler } = (await import('~/pages/api/mod/mod-rules')) as unknown as {
  default: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
};

const call = async (req: Partial<NextApiRequest>) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await handler(req as NextApiRequest, res as unknown as NextApiResponse);
  return {
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0],
  };
};
const update = {
  method: 'POST',
  body: { id: 12, userId: 1, action: 'Block', entityType: 'Image', definition: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.moderationRule.updateMany.mockResolvedValue({ count: 1 });
});

describe('/api/mod/mod-rules', () => {
  it('updates an Image rule', async () => {
    const { status } = await call(update);

    expect(status).toBe(200);
    expect(dbMock.dbWrite.moderationRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 12, entityType: 'Image' } })
    );
    expect(bustImageModRulesCache).toHaveBeenCalledTimes(1);
  });

  it('answers 404 and writes nothing for a Model rule id', async () => {
    // The Image-scoped where matches no Model row, so the update reports none changed.
    dbMock.dbWrite.moderationRule.updateMany.mockResolvedValue({ count: 0 });

    const { status } = await call({ ...update, body: { ...update.body, id: 99 } });

    expect(status).toBe(404);
    expect(dbMock.dbWrite.moderationRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 99, entityType: 'Image' } })
    );
    expect(bustImageModRulesCache).not.toHaveBeenCalled();
  });

  it('refuses to create a rule for another entity type', async () => {
    const { status } = await call({
      ...update,
      body: { ...update.body, id: undefined, entityType: 'Model' },
    });

    expect(status).toBe(400);
    expect(dbMock.dbWrite.moderationRule.create).not.toHaveBeenCalled();
  });

  it('answers 404 and deletes nothing for a Model rule id', async () => {
    dbMock.dbWrite.moderationRule.deleteMany.mockResolvedValue({ count: 0 });

    const { status } = await call({ method: 'DELETE', query: { id: '99' } });

    expect(status).toBe(404);
    expect(dbMock.dbWrite.moderationRule.deleteMany).toHaveBeenCalledWith({
      where: { id: 99, entityType: 'Image' },
    });
    expect(bustImageModRulesCache).not.toHaveBeenCalled();
  });
});
