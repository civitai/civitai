import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const count = dbMock.dbWrite.newOrderSmite.count;

const { resetPlayer } = vi.hoisted(() => ({ resetPlayer: vi.fn() }));
vi.mock('~/server/services/games/new-order.service', () => ({ resetPlayer }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

const { default: handler } = await import('~/pages/api/mod/knights/reset-player');

const call = async (method: string, body: Record<string, unknown>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await handler({ method, body } as NextApiRequest, res as unknown as NextApiResponse);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(3);
});

describe('/api/mod/knights/reset-player', () => {
  it('resets a player at the smite limit with the original game wording and a notification', async () => {
    const res = await call('POST', { playerId: '9' });

    expect(count).toHaveBeenCalledWith({ where: { targetPlayerId: 9, cleansedAt: null } });
    expect(resetPlayer).toHaveBeenCalledWith({
      playerId: 9,
      withNotification: true,
      reason: 'Your New Order career has been reset due to excessive smites.',
    });
    expect(res.json).toHaveBeenCalledWith({ playerId: 9, outcome: 'reset' });
  });

  it('is idempotent: a player under the limit, such as one already reset, is left alone', async () => {
    count.mockResolvedValue(0);
    const res = await call('POST', { playerId: '9' });

    expect(resetPlayer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ playerId: 9, outcome: 'not-due' });
  });

  it('lets a failing reset surface, so the caller retries', async () => {
    resetPlayer.mockRejectedValue(new Error('redis down'));
    await expect(call('POST', { playerId: '9' })).rejects.toThrow('redis down');
  });

  it.each([
    ['a missing player', {}],
    ['a non-positive player', { playerId: '0' }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await call('POST', body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(resetPlayer).not.toHaveBeenCalled();
  });

  it('answers 405 to anything but POST', async () => {
    const res = await call('GET', {});
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
