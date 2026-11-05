import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class Refused extends Error {
  constructor(readonly reason: string) {
    super(`refused ${reason}`);
  }
}
class CosmeticRefused extends Error {}

const mocks = vi.hoisted(() => ({
  grantMembershipMonths: vi.fn(),
  refresh: vi.fn(),
  equip: vi.fn(),
  unequip: vi.fn(),
}));
vi.mock('~/server/services/referral.service', () => ({
  grantMembershipMonths: mocks.grantMembershipMonths,
  MembershipGrantRefused: Refused,
}));
vi.mock('~/server/services/knights/shop.service', () => ({
  refreshKnightsShopCosmetics: mocks.refresh,
  equipKnightsShopCosmetic: mocks.equip,
  unequipKnightsShopCosmetic: mocks.unequip,
  KnightsCosmeticRefused: CosmeticRefused,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

const { default: membership } = await import('~/pages/api/mod/knights/shop/membership');
const { default: cosmetics } = await import('~/pages/api/mod/knights/shop/cosmetics');

const call = async (
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  body: Record<string, unknown>
) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await handler({ method, body } as NextApiRequest, res as unknown as NextApiResponse);
  return res;
};

beforeEach(() => vi.clearAllMocks());

const GRANT = { userId: '9', tier: 'silver', months: '1', key: 'knights-shop:abc-123' };

describe('/api/mod/knights/shop/membership', () => {
  it('grants once per key and reports what happened', async () => {
    mocks.grantMembershipMonths.mockResolvedValueOnce({ outcome: 'granted' });
    mocks.grantMembershipMonths.mockResolvedValueOnce({ outcome: 'already' });

    const first = await call(membership, 'POST', GRANT);
    const replay = await call(membership, 'POST', GRANT);

    expect(mocks.grantMembershipMonths).toHaveBeenCalledWith({
      userId: 9,
      tier: 'silver',
      months: 1,
      key: 'knights-shop:abc-123',
    });
    expect(first.json).toHaveBeenCalledWith({ outcome: 'granted' });
    expect(replay.json).toHaveBeenCalledWith({ outcome: 'already' });
    expect(replay.status).toHaveBeenCalledWith(200);
  });

  it('answers 409 with the reason when the grant is refused for good', async () => {
    mocks.grantMembershipMonths.mockRejectedValue(new Refused('queue-full'));
    const res = await call(membership, 'POST', GRANT);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'refused queue-full', reason: 'queue-full' });
  });

  it('lets an unexpected failure through as an error the caller retries', async () => {
    mocks.grantMembershipMonths.mockRejectedValue(new Error('db down'));
    await expect(call(membership, 'POST', GRANT)).rejects.toThrow('db down');
  });

  it.each([
    ['an unknown tier', { ...GRANT, tier: 'platinum' }],
    ['no key', { ...GRANT, key: '' }],
    ['zero months', { ...GRANT, months: '0' }],
    ['a missing user', { ...GRANT, userId: undefined }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await call(membership, 'POST', body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.grantMembershipMonths).not.toHaveBeenCalled();
  });

  it('only answers POST', async () => {
    expect((await call(membership, 'GET', {})).status).toHaveBeenCalledWith(405);
  });
});

describe('/api/mod/knights/shop/cosmetics', () => {
  it('refreshes, equips and unequips through the main app services', async () => {
    await call(cosmetics, 'POST', { action: 'refresh', userId: '9' });
    await call(cosmetics, 'POST', { action: 'equip', userId: '9', cosmeticId: '5' });
    await call(cosmetics, 'POST', { action: 'unequip', userId: '9', cosmeticId: '5' });

    expect(mocks.refresh).toHaveBeenCalledWith(9);
    expect(mocks.equip).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, cosmeticId: 5 }));
    expect(mocks.unequip).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 9, cosmeticId: 5 })
    );
  });

  it('answers 409 with the message when the main app will not equip it', async () => {
    mocks.equip.mockRejectedValue(new CosmeticRefused('Stickers cannot be equipped'));
    const res = await call(cosmetics, 'POST', { action: 'equip', userId: '9', cosmeticId: '5' });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Stickers cannot be equipped',
      reason: 'refused',
    });
  });

  it.each([
    ['an unknown action', { action: 'delete', userId: '9' }],
    ['an equip without a cosmetic', { action: 'equip', userId: '9' }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await call(cosmetics, 'POST', body);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
