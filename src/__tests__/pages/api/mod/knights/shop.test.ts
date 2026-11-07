import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '~/env/server';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';

class CosmeticRefused extends Error {}

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  refresh: vi.fn(),
  equip: vi.fn(),
  unequip: vi.fn(),
}));
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  grantBuzzPurchaseMembership: mocks.grant,
}));
vi.mock('~/server/services/knights/shop.service', () => ({
  refreshKnightsShopCosmetics: mocks.refresh,
  equipKnightsShopCosmetic: mocks.equip,
  unequipKnightsShopCosmetic: mocks.unequip,
  KnightsCosmeticRefused: CosmeticRefused,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: unknown) => handler }));

// The real `WebhookEndpoint`: the token check is the endpoints' only authentication.
const { default: membership } = await import('~/pages/api/mod/knights/shop/membership');
const { default: cosmetics } = await import('~/pages/api/mod/knights/shop/cosmetics');
const { BuzzMembershipRefusedError } = await import('~/server/services/subscriptions.service');

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
const TOKEN = String(env.WEBHOOK_TOKEN);

const call = async (
  handler: unknown,
  method: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { 'x-webhook-token': TOKEN }
) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    on: vi.fn(),
  };
  await (handler as Handler)(
    { method, body, headers, query: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
};

beforeEach(() => vi.clearAllMocks());

describe('webhook authentication', () => {
  it.each([
    ['no token', {}],
    ['a wrong token', { 'x-webhook-token': `${TOKEN}-nope` }],
  ])('answers 401 for %s and never reaches the service', async (_label, headers) => {
    const grantBody = { userId: '9', tier: 'silver', key: 'knights-shop:abc-123' };
    const grant = await call(membership, 'POST', grantBody, headers);
    const refresh = await call(cosmetics, 'POST', { action: 'refresh', userId: '9' }, headers);

    expect(grant.status).toHaveBeenCalledWith(401);
    expect(refresh.status).toHaveBeenCalledWith(401);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('serves the request when the token matches', async () => {
    mocks.grant.mockResolvedValue({ outcome: 'granted' });
    const res = await call(membership, 'POST', {
      userId: '9',
      tier: 'silver',
      key: 'knights-shop:abc-123',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

const GRANT = { userId: '9', tier: 'silver', key: 'knights-shop:abc-123' };

describe('/api/mod/knights/shop/membership', () => {
  it('grants with the purchase key and reports what happened', async () => {
    mocks.grant.mockResolvedValueOnce({ outcome: 'granted' });
    mocks.grant.mockResolvedValueOnce({ outcome: 'already' });

    const first = await call(membership, 'POST', GRANT);
    const replay = await call(membership, 'POST', GRANT);

    expect(mocks.grant).toHaveBeenCalledTimes(2);
    expect(mocks.grant).toHaveBeenNthCalledWith(1, {
      userId: 9,
      tier: 'silver',
      idempotencyKey: 'knights-shop:abc-123',
    });
    expect(first.json).toHaveBeenCalledWith({ outcome: 'granted' });
    expect(replay.json).toHaveBeenCalledWith({ outcome: 'already' });
    expect(replay.status).toHaveBeenCalledWith(200);
  });

  it('passes a 7-day request to the grant and grants the default length without days', async () => {
    mocks.grant.mockResolvedValue({ outcome: 'granted' });
    await call(membership, 'POST', { ...GRANT, days: 7 });
    await call(membership, 'POST', GRANT);

    expect(mocks.grant.mock.calls[0][0]).toMatchObject({ days: 7 });
    expect(mocks.grant.mock.calls[1][0].days).toBeUndefined();
  });

  it('answers 409 with the reason when the grant is refused for good', async () => {
    mocks.grant.mockRejectedValue(
      new BuzzMembershipRefusedError('active-membership', 'You already have an active membership')
    );
    const res = await call(membership, 'POST', GRANT);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You already have an active membership',
      reason: 'active-membership',
    });
  });

  it('lets an unexpected failure through as an error the caller retries', async () => {
    mocks.grant.mockRejectedValue(new Error('db down'));
    await expect(call(membership, 'POST', GRANT)).rejects.toThrow('db down');
  });

  it.each([
    ['an unknown tier', { ...GRANT, tier: 'platinum' }],
    ['a key under 8 characters', { ...GRANT, key: 'short-k' }],
    ['a key over 100 characters', { ...GRANT, key: 'k'.repeat(101) }],
    ['a length that is not a week', { ...GRANT, days: 30 }],
    ['a user id of zero', { ...GRANT, userId: '0' }],
    ['a missing user', { ...GRANT, userId: undefined }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await call(membership, 'POST', body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('accepts the key bounds', async () => {
    mocks.grant.mockResolvedValue({ outcome: 'granted' });
    for (const key of ['k'.repeat(8), 'k'.repeat(100)]) {
      const res = await call(membership, 'POST', { ...GRANT, key });
      expect(res.status).toHaveBeenCalledWith(200);
    }
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

  it('lets an unexpected failure through as an error the caller retries', async () => {
    mocks.refresh.mockRejectedValue(new Error('redis down'));
    await expect(call(cosmetics, 'POST', { action: 'refresh', userId: '9' })).rejects.toThrow(
      'redis down'
    );
  });

  it.each([
    ['an unknown action', { action: 'delete', userId: '9' }],
    ['an equip without a cosmetic', { action: 'equip', userId: '9' }],
    ['a cosmetic id of zero', { action: 'equip', userId: '9', cosmeticId: '0' }],
    ['a negative user id', { action: 'refresh', userId: '-1' }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await call(cosmetics, 'POST', body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.equip).not.toHaveBeenCalled();
    expect(mocks.unequip).not.toHaveBeenCalled();
  });

  it('only answers POST', async () => {
    expect((await call(cosmetics, 'GET', {})).status).toHaveBeenCalledWith(405);
  });
});
