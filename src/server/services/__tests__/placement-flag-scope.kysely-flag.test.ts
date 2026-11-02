import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementQueries from '@civitai/db-queries/placement';

// Where the Kysely placement reads reach, not what the ports return (that is
// placement-reads.kysely-flag.test.ts): the space resolution asks no placement flag, and nothing
// outside the placement read chain moves onto Kysely with it.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof PlacementQueries>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

import * as queries from '@civitai/db-queries/placement';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { isFlipt } from '~/server/flipt/client';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { getCapTier } from '~/server/services/subscriptions.service';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

const OWNER = 5101;
const IMAGE = 5202;

const goldSubscription = {
  id: 'sub-gold',
  status: 'active',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  canceledAt: null,
  currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  endedAt: null,
  metadata: {},
  buzzType: 'yellow',
  product: {
    id: 'prod-gold',
    name: 'Gold',
    description: null,
    metadata: { tier: 'gold' },
    provider: 'Civitai',
    active: true,
  },
  price: {
    id: 'price-gold',
    unitAmount: 5000,
    interval: 'month',
    intervalCount: 1,
    currency: 'usd',
    active: true,
  },
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of Object.values(q)) if (vi.isMockFunction(fn)) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  dbMock.dbWrite.customerSubscription.findMany.mockResolvedValue([goldSubscription]);
  q.getImagePlacementTarget.mockResolvedValue({
    id: IMAGE,
    userId: OWNER,
    postId: null,
    type: 'image',
    username: 'creator',
  } as never);
  q.listPlacementSpacesFor.mockResolvedValue([] as never);
  q.getUserPlacementScore.mockResolvedValue([{ score: 26_000 }] as never);
  q.listUserSubscriptionRows.mockResolvedValue([goldSubscription] as never);
});

describe('Kysely placement reads scope', () => {
  it('a space resolution asks no placement flag, and the price range reads Kysely once each', async () => {
    const space = await resolvePlacementSpaceFor({
      surface: 'sticker',
      targetType: 'image',
      targetId: IMAGE,
    });

    // The only key this path evaluates is `kysely-hot-reads-5` (`getPlacementConfig`'s KeyValue
    // read), by key alone. It is also the positive control that the flag mock is reached at all.
    const keys = flag.mock.calls.map((call) => {
      expect(call).toHaveLength(1);
      return call[0];
    });
    expect(keys).toContain('kysely-hot-reads-5');
    for (const key of keys) expect(key).toBe('kysely-hot-reads-5');
    expect(q.getUserPlacementScore).toHaveBeenCalledTimes(1);
    expect(q.listUserSubscriptionRows).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.customerSubscription.findMany).not.toHaveBeenCalled();
    expect(space.cap).toBe(2500); // gold at 26k: the tier and score reached the answer
  });

  // Early access, the model-version pricing allowance and announcements call getCapTier(userId).
  // They are not placement reads and stay on Prisma.
  it('getCapTier from a non-placement caller reads Prisma, and never asks a flag', async () => {
    await expect(getCapTier(OWNER)).resolves.toBe('gold');

    expect(dbMock.dbWrite.customerSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(q.listUserSubscriptionRows).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
  });
});
