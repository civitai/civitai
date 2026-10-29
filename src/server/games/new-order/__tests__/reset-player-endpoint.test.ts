import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const count = dbMock.dbWrite.newOrderSmite.count;

const { resetPlayer, withDistributedLock } = vi.hoisted(() => ({
  resetPlayer: vi.fn(),
  withDistributedLock: vi.fn(),
}));
vi.mock('~/server/services/games/new-order.service', () => ({ resetPlayer }));
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock }));
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
  withDistributedLock.mockImplementation(async (_options, operation) => operation());
});

describe('/api/mod/knights/reset-player', () => {
  it('resets a player at the smite limit with the original game wording and a notification', async () => {
    const res = await call('POST', { playerId: '9', limit: '3' });

    expect(count).toHaveBeenCalledWith({ where: { targetPlayerId: 9, cleansedAt: null } });
    expect(resetPlayer).toHaveBeenCalledWith({
      playerId: 9,
      withNotification: true,
      reason: 'Your New Order career has been reset due to excessive smites.',
    });
    expect(res.json).toHaveBeenCalledWith({ playerId: 9, outcome: 'reset' });
  });

  it('uses the limit the caller names, not a fixed one', async () => {
    count.mockResolvedValue(2);
    expect((await call('POST', { playerId: '9', limit: '3' })).json).toHaveBeenCalledWith({
      playerId: 9,
      outcome: 'not-due',
    });
    expect((await call('POST', { playerId: '9', limit: '2' })).json).toHaveBeenCalledWith({
      playerId: 9,
      outcome: 'reset',
    });
  });

  it('is idempotent: a player under the limit, such as one already reset, is left alone', async () => {
    count.mockResolvedValue(0);
    const res = await call('POST', { playerId: '9', limit: '3' });

    expect(resetPlayer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ playerId: 9, outcome: 'not-due' });
  });

  it('decides under a lock held for that player', async () => {
    await call('POST', { playerId: '9', limit: '3' });
    expect(withDistributedLock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'knights:reset-player:9' }),
      expect.any(Function)
    );
  });

  it('asks the caller to retry when another reset of the player holds the lock', async () => {
    withDistributedLock.mockResolvedValue(null);
    const res = await call('POST', { playerId: '9', limit: '3' });
    expect(resetPlayer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('lets a reset that did not happen surface, so the caller retries', async () => {
    resetPlayer.mockRejectedValue(new Error('db down'));
    await expect(call('POST', { playerId: '9', limit: '3' })).rejects.toThrow('db down');
  });

  it('answers reset and logs when only the side effects after the commit failed', async () => {
    resetPlayer.mockImplementation(async () => {
      count.mockResolvedValue(0);
      throw new Error('redis down');
    });
    const res = await call('POST', { playerId: '9', limit: '3' });

    expect(res.json).toHaveBeenCalledWith({ playerId: 9, outcome: 'reset' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'knights-reset-side-effects-failed',
        details: { playerId: 9 },
      })
    );
  });

  it.each([
    ['a missing player', {}],
    ['a non-positive player', { playerId: '0', limit: '3' }],
    ['a missing limit', { playerId: '9' }],
    ['a limit below the floor', { playerId: '9', limit: '1' }],
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
